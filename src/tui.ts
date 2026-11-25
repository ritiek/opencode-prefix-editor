import { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"
import { readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyEdits,
  current,
  freshId,
  outline,
  parse,
  rebuild,
  render,
  REQUEST,
  withoutRequests,
  type Edit,
  type Prefix,
  type SystemSpec,
  type Transfer,
} from "./format.ts"
import { PrefixEditor } from "./rpc.ts"

const SUFFIX = " (edited)"

const request = (instruction: string, sections: string) => `Edit this session's prefix (its system prompt and history) as the user instructs below. Call edit_prefix once, right away, with the instruction and a list of edits. Do not reply or do anything else.

Sections are named by ref: \`#N\` is a message, \`#N.M\` a part of assistant message N, \`system-prompt #N\` a system prompt section. Refs always name the sections listed below, so earlier edits do not shift them.
- {op: "delete", ref}: remove a section. Deleting a tool part removes the call and its output.
- {op: "replace", ref, text, section?}: replace a section's text. On a tool part, section is "tool-input" (JSON) or "tool-output" (the default). Replace an assistant message's parts, not the message.
- {op: "insert", after?, text}: add a user message after message \`after\` (at the end when omitted), a text part after part \`after\`, or a system prompt section after \`after\`.

Make only the changes the instruction asks for. Your messages are in your context; use them for replacement text. The user reviews the result in their editor before it is saved as a new session, and the original session is kept.

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
    const openEditor = async (text: string) => {
      const [command, ...args] = (process.env.VISUAL || process.env.EDITOR || "vi").split(" ")
      const file = join(tmpdir(), `opencode-prefix-${Date.now()}.md`)
      await writeFile(file, text)
      await ctx.renderer.suspend()
      try {
        await new Promise<void>((resolve, reject) =>
          spawn(command!, [...args, file], { stdio: "inherit" })
            .on("error", reject)
            .on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Editor exited with code ${code}`)))),
        )
        return await readFile(file, "utf8")
      } finally {
        await rm(file, { force: true })
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
    type Snapshot = { s: Session; transfer: Transfer; prefix: Prefix }

    const snapshot = async (s: Session): Promise<Snapshot> => {
      const [{ system }, exported] = await Promise.all([
        rpc.getSystem({ sessionID: s.sessionID }, s.options) as Promise<{ system: SystemSpec }>,
        ctx.client.experimental.session.export({ sessionID: s.sessionID }),
      ])
      const transfer = { ...exported, messages: withoutRequests(exported.messages) }
      return { s, transfer, prefix: current(transfer.messages, system) }
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

    /** Opens `text` in the editor until it is saved as a new session or given up on; returns what happened. */
    const review = async ({ s, transfer, prefix }: Snapshot, text: string): Promise<string> => {
      const before = parse(render(prefix))
      for (;;) {
        text = await openEditor(text)
        try {
          const after = parse(text)
          if (!text.trim() || JSON.stringify(after) === JSON.stringify(before)) {
            toast("Prefix unchanged")
            return "The prefix is unchanged; nothing was saved."
          }
          // Every edit lands in a copy, so the original session is the undo. rebuild() validates before anything is written.
          const edited = await fork(transfer, rebuild(after.messages, transfer.messages), s.location)
          await rpc.setSystem({ sessionID: edited.id, system: after.system }, s.options)
          // Import emits no message events, so load the new session into the TUI's cache before showing it.
          await ctx.data.session.sync(edited.id)
          await ctx.data.session.message.sync(edited.id)
          ctx.ui.router.navigate({ type: "session", sessionID: edited.id })
          toast(`Saved as "${edited.title}"`, "success")
          return `Saved as a new session, "${edited.title}". Stop here; do not reply.`
        } catch (e) {
          // Keep the user's edits: offer to reopen them instead of discarding.
          const retry = await ctx.ui.dialog.confirm({
            title: "Invalid prefix",
            message: `${(e as Error).message}\n\nReopen the editor?`,
            label: { confirm: "Reopen", cancel: "Discard" },
          })
          if (!retry) return "The user discarded the edits."
        }
      }
    }

    // Snapshots taken by /edit-prefix <instruction>, by session. They predate the request, so the request
    // and the edit_prefix call never end up in the edited copy.
    const requests = new Map<string, Snapshot>()

    /** Applies the model's edits and has the user review them; returns what edit_prefix tells the model. */
    const draft = async (snap: Snapshot, edits: Edit[]) => {
      let text: string
      try {
        text = render(applyEdits(snap.prefix, edits))
        rebuild(parse(text).messages, snap.transfer.messages) // the checks saving runs, reported to the model instead
      } catch (e) {
        // Keep the snapshot so the model can call edit_prefix again with fixed edits.
        return `Edits not applied: ${(e as Error).message}. Fix them and call edit_prefix again.`
      }
      requests.delete(snap.s.sessionID)
      return review(snap, text)
    }

    rpc.events.on("draft", (event) => {
      const { draftID, sessionID, edits } = event.data as { draftID: string; sessionID: string; edits: Edit[] }
      const snap = requests.get(sessionID)
      if (!snap) return // not this TUI's request
      // Each location runs its own server plugin instance; reply to the one that sent the draft.
      const options = { location: event.location }
      const handle = async () => {
        const { claimed } = (await rpc.claim({ draftID }, options)) as { claimed: boolean }
        if (!claimed) return
        const result = await draft(snap, edits).catch((e: Error) => `Edits not saved: ${e.message}`)
        await rpc.settle({ draftID, result }, options)
      }
      handle().catch((e) => toast((e as Error).message, "error"))
    })

    const editPrefix = async (instruction?: string) => {
      const s = session()
      if (!s) return toast("Open a session first", "error")
      const snap = await snapshot(s)
      if (!instruction?.trim()) return void (await review(snap, render(snap.prefix)))
      requests.set(s.sessionID, snap)
      const text = request(instruction.trim(), outline(snap.prefix))
      await ctx.client.session.prompt({ sessionID: s.sessionID, text, metadata: REQUEST })
    }

    const run = (action: () => Promise<unknown>) => {
      action().catch((e) => toast((e as Error).message, "error"))
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
          run: (input) => run(() => editPrefix(input)),
        },
      ],
    }))
  },
})
