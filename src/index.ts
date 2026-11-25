import { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { resolveSystem, systemSpec, type SystemSpec } from "./format.ts"
import { edits, PrefixEditor } from "./rpc.ts"

/** How long a TUI has to claim an edit_prefix draft. */
const CLAIM_TIMEOUT_MS = 3000

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

    // edit_prefix drafts waiting on the TUI. `claim` is set until a TUI claims the draft.
    const drafts = new Map<string, { claim?: () => void; settle: (result: string) => void }>()

    const rpc = await ctx.rpc.register(PrefixEditor, {
      claim: async (input) => {
        const draft = drafts.get((input as { draftID: string }).draftID)
        if (!draft?.claim) return { claimed: false }
        draft.claim()
        draft.claim = undefined
        return { claimed: true }
      },
      settle: async (input) => {
        const { draftID, result } = input as { draftID: string; result: string }
        drafts.get(draftID)?.settle(result)
        drafts.delete(draftID)
        return {}
      },
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

    // The edits are applied and reviewed by the TUI, which holds the session snapshot /edit-prefix took.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "edit_prefix",
        description:
          "Edit this session's system prompt and history. Only call this when /edit-prefix asks you to; it lists the section refs. The user reviews the result in $EDITOR and it is saved as a new session.",
        input: {
          type: "object",
          properties: {
            instruction: { type: "string", description: "The user's instruction, as given" },
            edits: { ...edits, description: "Edits, applied in order" },
          },
          required: ["instruction", "edits"],
          additionalProperties: false,
        },
        // A direct call: replacement text stays structured JSON instead of string literals in Code Mode code.
        options: { codemode: false },
        async execute(input, context) {
          const draftID = crypto.randomUUID()
          const result = await new Promise<string>((resolve) => {
            const timer = setTimeout(() => {
              drafts.delete(draftID)
              resolve("No terminal UI picked up the edits: edit_prefix only works after /edit-prefix <instruction> in the TUI.")
            }, CLAIM_TIMEOUT_MS)
            drafts.set(draftID, { claim: () => clearTimeout(timer), settle: resolve })
            context.signal.addEventListener("abort", () => {
              clearTimeout(timer)
              drafts.delete(draftID)
              resolve("Cancelled.")
            }, { once: true })
            rpc.events
              .emit("draft", { draftID, sessionID: context.sessionID, edits: (input as { edits: unknown[] }).edits })
              .catch((e) => resolve(`Could not reach the TUI: ${(e as Error).message}`))
          })
          return { content: result }
        },
      })
    })
  },
})
