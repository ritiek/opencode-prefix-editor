import { Plugin } from "@opencode/plugin"
import { current, edit, ids, render, resolve, stale, type Request, type Spec } from "./format.ts"
import { PrefixEditor, type Ids } from "./rpc.ts"

export default Plugin.define({
  id: "prefix-editor",
  async setup(ctx) {
    const key = (sessionID: string) => `edit/${sessionID}`
    const load = async (sessionID: string) => (await ctx.storage.get(key(sessionID))) as Spec | undefined
    const drop = (sessionID: string) => ctx.storage.remove(key(sessionID))

    await ctx.session.hook("context", async (event) => {
      const spec = await load(event.sessionID)
      if (!spec) return
      if (stale(spec, event)) return drop(event.sessionID)
      try {
        Object.assign(event, resolve(spec, event))
      } catch {
        await drop(event.sessionID) // never let a broken edit wedge the session
      }
    })

    // The context hook only runs on model calls, so snapshot the session on demand through a transient
    // generate request, aborted in its hook before anything reaches the model.
    const pending = new Map<string, (request: Request) => void>()
    await ctx.session.hook("generate", (event) => {
      const last = event.messages.at(-1)?.content[0]
      const take = last?.type === "text" ? pending.get(last.text) : undefined
      if (!take) return
      take({ system: event.system, messages: event.messages.slice(0, -1) })
      throw new Error("prefix-editor: snapshot taken")
    })
    const snapshot = async (sessionID: string) => {
      const token = `prefix-editor:${crypto.randomUUID()}`
      let request: Request | undefined
      pending.set(token, (r) => (request = r))
      await ctx.session.generate({ sessionID, prompt: token }).catch(() => {})
      pending.delete(token)
      if (!request) throw new Error("Could not read the session context")
      return request
    }

    await ctx.rpc.register(PrefixEditor, {
      render: async (input, { error }) => {
        const { sessionID } = input as { sessionID: string }
        try {
          const orig = await snapshot(sessionID)
          const spec = await load(sessionID)
          return { text: render(current(orig, spec && !stale(spec, orig) ? spec : undefined)), ids: ids(orig.messages) }
        } catch (e) {
          return error("failed", (e as Error).message, {})
        }
      },
      apply: async (input, { error }) => {
        const { sessionID, text, ids: base } = input as { sessionID: string; text: string; ids: Ids }
        try {
          await ctx.storage.set(key(sessionID), edit(text, await snapshot(sessionID), base))
          return {}
        } catch (e) {
          return error("failed", (e as Error).message, {})
        }
      },
      reset: async (input) => {
        await drop((input as { sessionID: string }).sessionID)
        return {}
      },
    })
  },
})
