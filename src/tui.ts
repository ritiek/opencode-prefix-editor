import { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"
import { readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { current, freshId, parse, rebuild, render, type SystemSpec, type Transfer } from "./format.ts"
import { PrefixEditor } from "./rpc.ts"

const SUFFIX = " (edited)"

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

    // RPC calls go to the server plugin instance at the session's location.
    const session = () => {
      const route = ctx.ui.router.current()
      if (route.type !== "session") return
      const location = ctx.data.session.get(route.sessionID)?.location
      return { rpc: ctx.client.rpc(PrefixEditor), sessionID: route.sessionID, location, options: { location } }
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

    const editPrefix = async () => {
      const s = session()
      if (!s) return toast("Open a session first", "error")
      const [{ system }, transfer] = await Promise.all([
        s.rpc.getSystem({ sessionID: s.sessionID }, s.options) as Promise<{ system: SystemSpec }>,
        ctx.client.experimental.session.export({ sessionID: s.sessionID }),
      ])
      const original = render(current(transfer.messages, system))
      const before = parse(original)
      let text = original
      for (;;) {
        text = await openEditor(text)
        try {
          const after = parse(text)
          const messages = JSON.stringify(after.messages) !== JSON.stringify(before.messages)
          const prompt = JSON.stringify(after.system) !== JSON.stringify(before.system)
          if (!text.trim() || (!messages && !prompt)) return toast("Prefix unchanged")
          // rebuild() validates everything before anything is written.
          const edited = messages ? await fork(transfer, rebuild(after.messages, transfer.messages), s.location) : undefined
          await s.rpc.setSystem({ sessionID: edited?.id ?? s.sessionID, system: after.system }, s.options)
          if (!edited) return toast("System prompt updated", "success")
          // Import emits no message events, so load the new session into the TUI's cache before showing it.
          await ctx.data.session.sync(edited.id)
          await ctx.data.session.message.sync(edited.id)
          ctx.ui.router.navigate({ type: "session", sessionID: edited.id })
          return toast(`Saved as "${edited.title}"`, "success")
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

    const resetPrefix = async () => {
      const s = session()
      if (!s) return toast("Open a session first", "error")
      await s.rpc.reset({ sessionID: s.sessionID }, s.options)
      toast("System prompt reset to the generated one", "success")
    }

    const run = (action: () => Promise<unknown>) => () => {
      action().catch((e) => toast((e as Error).message, "error"))
    }

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "prefix-editor.edit",
          title: "Edit prefix in $EDITOR",
          description: "Edit the system prompt and conversation history; history edits save as a new session",
          group: "Session",
          palette: true,
          slash: { name: "edit-prefix" },
          run: run(editPrefix),
        },
        {
          id: "prefix-editor.reset",
          title: "Reset system prompt",
          description: "Drop this session's system prompt edit",
          group: "Session",
          palette: true,
          slash: { name: "reset-prefix" },
          run: run(resetPrefix),
        },
      ],
    }))
  },
})
