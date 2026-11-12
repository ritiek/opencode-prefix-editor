import { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"
import { readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PrefixEditor, type Ids } from "./rpc.ts"

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
      return { rpc: ctx.client.rpc(PrefixEditor), sessionID: route.sessionID, options: { location } }
    }

    const editPrefix = async () => {
      const s = session()
      if (!s) return toast("Open a session first", "error")
      const rendered = (await s.rpc.render({ sessionID: s.sessionID }, s.options)) as { text: string; ids: Ids }
      let text = rendered.text
      for (;;) {
        text = await openEditor(text)
        if (!text.trim() || text === rendered.text) return toast("Prefix unchanged")
        try {
          await s.rpc.apply({ sessionID: s.sessionID, text, ids: rendered.ids }, s.options)
          return toast("Prefix updated; applies from the next request", "success")
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
      toast("Prefix reset to the original history", "success")
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
          description: "Edit the system prompt and conversation history the model sees",
          group: "Session",
          palette: true,
          slash: { name: "edit-prefix" },
          run: run(editPrefix),
        },
        {
          id: "prefix-editor.reset",
          title: "Reset edited prefix",
          description: "Send the original system prompt and history again",
          group: "Session",
          palette: true,
          slash: { name: "reset-prefix" },
          run: run(resetPrefix),
        },
      ],
    }))
  },
})
