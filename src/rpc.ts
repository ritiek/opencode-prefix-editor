import { Rpc } from "@opencode/plugin/rpc"

const object = (properties: Record<string, object>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false }) as const
const sessionID = { type: "string" }
const draftID = { type: "string" }
// SystemSpec: system prompt sections, each optionally tied to the generated part it replaces.
const system = {
  type: "array",
  items: { type: "object", properties: { ref: { type: "integer" }, text: { type: "string" } }, required: ["text"] },
}
const errors = { failed: { type: "object" } } as const

/** One edit_prefix edit; op-specific fields are checked by applyEdits(). */
export const EditSchema = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["delete", "replace", "insert"] },
    ref: { type: "string", description: "Section to delete or replace: #N, #N.M or system-prompt #N" },
    after: { type: "string", description: "insert: section to insert after; omit to append a user message at the end" },
    text: { type: "string", description: "replace/insert: the new text" },
    section: { type: "string", enum: ["tool-input", "tool-output"], description: "replace on a tool part: which side (default tool-output)" },
  },
  required: ["op"],
  additionalProperties: false,
} as const
export const edits = { type: "array", items: EditSchema }

// The system prompt is not stored in the session, so the server part overrides it per request.
// edit_prefix announces a `draft`; the TUI that ran /edit-prefix for that session `claim`s it,
// has the user review it, and `settle`s it with the result the tool returns.
export const PrefixEditor = Rpc.define({
  id: "prefix-editor",
  methods: {
    getSystem: { input: object({ sessionID }), output: object({ system }), errors },
    setSystem: { input: object({ sessionID, system }), output: object({}), errors },
    claim: { input: object({ draftID }), output: object({ claimed: { type: "boolean" } }) },
    settle: { input: object({ draftID, result: { type: "string" } }), output: object({}) },
  },
  events: {
    draft: { schema: object({ draftID, sessionID, edits }) },
  },
})
