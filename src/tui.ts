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
          if (!text.trim() || JSON.stringify(after) === JSON.stringify(before)) return toast("Prefix unchanged")
          // Every edit lands in a copy, so the original session is the undo. rebuild() validates before anything is written.
          const edited = await fork(transfer, rebuild(after.messages, transfer.messages), s.location)
          await s.rpc.setSystem({ sessionID: edited.id, system: after.system }, s.options)
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

    const run = (action: () => Promise<unknown>) => () => {
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
          slash: { name: "edit-prefix" },
          run: run(editPrefix),
        },
      ],
    }))
  },
})
