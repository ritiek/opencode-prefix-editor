import { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyEdits,
  current,
  diffSystem,
  extractEdits,
  freshId,
  outline,
  parse,
  rebuild,
  render,
  withoutRequests,
  type Prefix,
  type Section,
  type SystemEdits,
  type Transfer,
} from "./format.ts"
import { PrefixEditor } from "./rpc.ts"

const SUFFIX = " (edited)"
/** How often the model may correct a reply that does not parse or apply. */
const RETRIES = 2

const request = (instruction: string, sections: string) => `Edit this session's prefix (its system prompt and history) as the user instructs below. Reply with only a JSON array of edits in a \`\`\`json code block. Do not call tools and do not write anything else.

Sections are named by ref: \`#N\` is a message, \`#N.M\` a part of assistant message N, \`system-prompt #N\` a system prompt section. Refs always name the sections listed below, so earlier edits do not shift them.
- {"op": "delete", "ref": "#N"}: remove a section. Deleting a tool part removes the call and its output.
- {"op": "replace", "ref": "#N.M", "text": "...", "section": "tool-input" | "tool-output"}: replace a section's text. "section" is only for tool parts: "tool-input" (JSON) or "tool-output" (the default). Replace an assistant message's parts, not the message.
- {"op": "insert", "after": "#N", "text": "..."}: add a user message after message \`after\` (at the end when omitted), a text part after part \`after\`, or a system prompt section after \`after\`.

Messages labelled "(not sent)" were compacted away and no longer reach you; "(sent as summary text)" ones reach you only inside the summary. Make only the changes the instruction asks for, and use the conversation above for replacement text. The user reviews the result in their editor before it is saved as a new session; the original session is kept unchanged.

<instruction>
${instruction}
</instruction>

<sections>
${sections}
</sections>`

export default Plugin.define({
  id: "prefix-editor",
  setup(ctx) {
    const toast = (message: string, variant: "info" | "success" | "error" = "info") =>
      ctx.ui.toast.show({ title: "Prefix editor", message, variant })

    // Same approach as OpenCode's own external editor: suspend the TUI, hand the terminal to $VISUAL/$EDITOR.
    // The file holds the whole session, so it lives in a private directory and only the user can read it.
    const openEditor = async (text: string) => {
      const [command, ...args] = (process.env.VISUAL || process.env.EDITOR || "vi").split(" ")
      const dir = await mkdtemp(join(tmpdir(), "opencode-prefix-"))
      const file = join(dir, "prefix.md")
      await writeFile(file, text, { mode: 0o600 })
      await ctx.renderer.suspend()
      try {
        await new Promise<void>((resolve, reject) =>
          spawn(command!, [...args, file], { stdio: "inherit" })
            .on("error", reject)
            .on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Editor exited with code ${code}`)))),
        )
        return await readFile(file, "utf8")
      } finally {
        await rm(dir, { recursive: true, force: true })
        await ctx.renderer.resume()
      }
    }

    const rpc = ctx.client.rpc(PrefixEditor)
    // RPC calls go to the server plugin instance at the session's location.
    const session = () => {
      const route = ctx.ui.router.current()
      if (route.type !== "session") return
      const location = ctx.data.session.get(route.sessionID)?.location
      return { sessionID: route.sessionID, location, options: { location } }
    }
    type Session = NonNullable<ReturnType<typeof session>>
    type Snapshot = { s: Session; transfer: Transfer; prefix: Prefix; shown: Section[]; hidden: SystemEdits["edits"] }

    const snapshot = async (s: Session): Promise<Snapshot> => {
      const [{ sections: shown, hidden }, exported] = await Promise.all([
        rpc.getSystem({ sessionID: s.sessionID }, s.options) as Promise<{ sections: Section[]; hidden: SystemEdits["edits"] }>,
        ctx.client.experimental.session.export({ sessionID: s.sessionID }),
      ])
      // v0.2 sent /edit-prefix requests into the session; keep those turns out of copies.
      const transfer = { ...exported, messages: withoutRequests(exported.messages) }
      const system = shown.map((section, ref) => ({ ref, text: section.text, label: section.label }))
      return { s, transfer, prefix: current(transfer.messages, system), shown, hidden }
    }

    // Stored messages can't be edited in place, so the edited history becomes a new session.
    const fork = async ({ info }: Transfer, messages: Transfer["messages"], location: unknown) => {
      const { revert: _, fork: __, ...rest } = info
      const now = Date.now()
      const title = info.title?.endsWith(SUFFIX) ? info.title : `${info.title ?? "Untitled"}${SUFFIX}`
      return ctx.client.experimental.session.import({
        info: { ...rest, id: freshId(info.id), title, time: { ...info.time, created: now, updated: now } },
        messages,
        location,
      } as Parameters<typeof ctx.client.experimental.session.import>[0])
    }

    /** Opens `text` in the editor until it is saved as a new session or given up on. */
    const review = async ({ s, transfer, prefix, shown, hidden }: Snapshot, text: string, instruction?: string) => {
      const before = parse(render(prefix))
      for (;;) {
        text = await openEditor(text)
        try {
          const after = parse(text)
          if (!text.trim() || JSON.stringify(after) === JSON.stringify(before)) return toast("Prefix unchanged")
          // Every edit lands in a copy, so the original session is the undo. rebuild() validates before anything is written.
          const messages = rebuild(after.messages, transfer.messages)
          const edits = diffSystem(shown, after.system, hidden)
          const edited = await fork(transfer, messages, s.location)
          await rpc.setSystem({ sessionID: edited.id, edits }, s.options)
          // Import emits no message events, so load the new session into the TUI's cache before showing it.
          await ctx.data.session.sync(edited.id)
          await ctx.data.session.message.sync(edited.id)
          ctx.ui.router.navigate({ type: "session", sessionID: edited.id })
          toast(`Saved as "${edited.title}"`, "success")
          // A line in the original saying where the edit went; the model never sees it.
          const command = instruction ? `/edit-prefix ${instruction}` : "/edit-prefix"
          await rpc
            .note({ sessionID: s.sessionID, description: `${command} → saved as "${edited.title}"` }, s.options)
            .catch((e: Error) => toast(`Saved, but could not note it in the original session: ${e.message}`, "error"))
          return
        } catch (e) {
          // Keep the user's edits: offer to reopen them instead of discarding.
          const retry = await ctx.ui.dialog.confirm({
            title: "Invalid prefix",
            message: `${(e as Error).message}\n\nReopen the editor?`,
            label: { confirm: "Reopen", cancel: "Discard" },
          })
          if (!retry) return
        }
      }
    }

    /**
     * Asks the model for edits through a transient generate request, which sees the session's context but adds
     * nothing to it. Replies that don't parse or apply go back to the model with the error.
     */
    const ask = async (snap: Snapshot, instruction: string) => {
      const base = request(instruction, outline(snap.prefix))
      let prompt = base
      for (let attempt = 0; ; attempt++) {
        toast(attempt ? `Asking the model to correct its edits (${attempt}/${RETRIES})…` : "Asking the model for edits…")
        const { text: reply } = await ctx.client.session.generate({ sessionID: snap.s.sessionID, prompt })
        try {
          const text = render(applyEdits(snap.prefix, extractEdits(reply)))
          rebuild(parse(text).messages, snap.transfer.messages) // the checks saving runs, reported to the model instead
          return text
        } catch (e) {
          const error = (e as Error).message
          if (attempt === RETRIES) throw new Error(`The model's edits could not be applied: ${error}`)
          prompt = `${base}\n\nYour previous reply:\n<reply>\n${reply}\n</reply>\n\nIt could not be applied: ${error}. Reply with the corrected JSON array only.`
        }
      }
    }

    const editPrefix = async (instruction?: string) => {
      const s = session()
      if (!s) return toast("Open a session first", "error")
      // A running turn is only partly in the model's context, so its refs would not line up.
      if (ctx.data.session.status(s.sessionID) === "running") return toast("Wait for the session to finish first", "error")
      const snap = await snapshot(s)
      const asked = instruction?.trim()
      const text = asked ? await ask(snap, asked) : render(snap.prefix)
      await review(snap, text, asked)
    }

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "prefix-editor.edit",
          title: "Edit prefix in $EDITOR",
          description: "Edit the system prompt and conversation history; saves as a new session",
          group: "Session",
          palette: true,
          slash: { name: "edit-prefix", arguments: true },
          run: (input) => {
            editPrefix(input).catch((e) => toast((e as Error).message, "error"))
          },
        },
      ],
    }))
  },
})
