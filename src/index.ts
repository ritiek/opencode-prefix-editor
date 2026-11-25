import { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { hiddenEdits, isEmpty, NOTE, resolveSystem, sections, type StoredSystem, type SystemEdits } from "./format.ts"
import { PrefixEditor } from "./rpc.ts"

// Edits are saved as a new session (TUI part). The system prompt is generated per request, so the
// new session's system prompt edits are stored here and applied to their sources before each model call.
export default Plugin.define({
  id: "prefix-editor",
  async setup(ctx) {
    const key = (sessionID: string) => `system/${sessionID}`
    const load = async (sessionID: string) => (await ctx.storage.get(key(sessionID))) as StoredSystem | undefined

    // The context hook only runs on model calls, so read the generated system prompt through a transient
    // generate request, aborted in its hook before anything reaches the model. Registered before the hooks
    // below, so the snapshot is always OpenCode's own prompt.
    const pending = new Map<string, (event: SessionContext) => void>()
    await ctx.session.hook("generate", (event) => {
      const last = event.messages.at(-1)?.content[0]
      const take = last?.type === "text" ? pending.get(last.text) : undefined
      if (!take) return
      take(event)
      throw new Error("prefix-editor: snapshot taken")
    })
    const snapshot = async (sessionID: string) => {
      const token = `prefix-editor:${crypto.randomUUID()}`
      let taken: SessionContext | undefined
      pending.set(token, (event) => (taken = event))
      await ctx.session.generate({ sessionID, prompt: token }).catch(() => {})
      pending.delete(token)
      if (!taken) throw new Error("Could not read the session's system prompt")
      return taken
    }

    // Notices left in sessions a copy was made from: shown in the transcript, never sent to the model.
    const notesKey = (sessionID: string) => `notes/${sessionID}`
    const notes = async (sessionID: string) => ((await ctx.storage.get(notesKey(sessionID))) as string[] | undefined) ?? []

    // Agent loop requests, and /edit-prefix <instruction>'s generate request, see the edited prompt.
    for (const kind of ["context", "generate", "compaction"] as const)
      await ctx.session.hook(kind, async (event) => {
        const stored = kind === "compaction" ? undefined : await load(event.sessionID)
        if (stored) event.system = resolveSystem(stored, event.system, event.agent)
        const hidden = await notes(event.sessionID)
        if (hidden.length) event.messages = event.messages.filter((m) => !m.id || !hidden.includes(m.id))
      })

    await ctx.rpc.register(PrefixEditor, {
      getSystem: async (input, { error }) => {
        const { sessionID } = input as { sessionID: string }
        try {
          const { system, agent } = await snapshot(sessionID)
          const stored = await load(sessionID)
          const shown = sections(system, agent, stored)
          return { sections: shown, hidden: hiddenEdits(shown, stored, system) }
        } catch (e) {
          return error("failed", (e as Error).message, {})
        }
      },
      setSystem: async (input) => {
        const { sessionID, edits } = input as { sessionID: string; edits: SystemEdits }
        if (isEmpty(edits)) await ctx.storage.remove(key(sessionID))
        else await ctx.storage.set(key(sessionID), edits)
        return {}
      },
      note: async (input) => {
        const { sessionID, description } = input as { sessionID: string; description: string }
        const id = `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`
        // Recorded before posting, so no request can see the notice unfiltered.
        await ctx.storage.set(notesKey(sessionID), [...(await notes(sessionID)), id])
        // resume: false leaves the model asleep; the notice is delivered with the session's next turn.
        const text = `[prefix-editor] ${description}`
        await ctx.session.synthetic({ sessionID, id, text, description, metadata: NOTE, resume: false })
        return {}
      },
    })
  },
})
