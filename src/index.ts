import { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { resolveSystem, systemSpec, type SystemSpec } from "./format.ts"
import { PrefixEditor } from "./rpc.ts"

// Edits are saved as a new session (TUI part). The system prompt is generated per request, so the
// new session's edited prompt is stored here and swapped in before each model call.
export default Plugin.define({
  id: "prefix-editor",
  async setup(ctx) {
    const key = (sessionID: string) => `system/${sessionID}`
    const load = async (sessionID: string) => (await ctx.storage.get(key(sessionID))) as SystemSpec | undefined

    await ctx.session.hook("context", async (event) => {
      const spec = await load(event.sessionID)
      if (spec) event.system = resolveSystem(spec, event.system)
    })

    // The context hook only runs on model calls, so read the generated system prompt through a transient
    // generate request, aborted in its hook before anything reaches the model.
    const pending = new Map<string, (system: SessionContext["system"]) => void>()
    await ctx.session.hook("generate", (event) => {
      const last = event.messages.at(-1)?.content[0]
      const take = last?.type === "text" ? pending.get(last.text) : undefined
      if (!take) return
      take(event.system)
      throw new Error("prefix-editor: snapshot taken")
    })
    const snapshot = async (sessionID: string) => {
      const token = `prefix-editor:${crypto.randomUUID()}`
      let system: SessionContext["system"] | undefined
      pending.set(token, (s) => (system = s))
      await ctx.session.generate({ sessionID, prompt: token }).catch(() => {})
      pending.delete(token)
      if (!system) throw new Error("Could not read the session's system prompt")
      return system
    }

    await ctx.rpc.register(PrefixEditor, {
      getSystem: async (input, { error }) => {
        const { sessionID } = input as { sessionID: string }
        try {
          return { system: (await load(sessionID)) ?? systemSpec(await snapshot(sessionID)) }
        } catch (e) {
          return error("failed", (e as Error).message, {})
        }
      },
      setSystem: async (input, { error }) => {
        const { sessionID, system } = input as { sessionID: string; system: SystemSpec }
        try {
          const orig = await snapshot(sessionID)
          const resolved = resolveSystem(system, orig)
          // An edit that resolves back to the generated prompt is no edit at all.
          if (resolved.length === orig.length && resolved.every((part, i) => part === orig[i])) await ctx.storage.remove(key(sessionID))
          else await ctx.storage.set(key(sessionID), system)
          return {}
        } catch (e) {
          return error("failed", (e as Error).message, {})
        }
      },
    })
  },
})
