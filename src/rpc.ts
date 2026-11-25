import { Rpc } from "@opencode/plugin/rpc"

const object = (properties: Record<string, object>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false }) as const
const sessionID = { type: "string" }
const errors = { failed: { type: "object" } } as const
// Shapes are Section, SystemEdits["edits"] and SystemEdits in format.ts.
const anchor = { type: "object" }
const edit = { type: "object", properties: { anchor, text: { type: ["string", "null"] } }, required: ["anchor", "text"] }
const section = {
  type: "object",
  properties: { anchor, generated: { type: "string" }, text: { type: "string" }, label: { type: "string" } },
  required: ["generated", "text", "label"],
}
const edits = object({ edits: { type: "array", items: edit }, inserted: { type: "array", items: { type: "string" } } })

// The system prompt is not stored in the session, so the server part reads it from a generate request and
// stores each copy's edits, applying them per request.
export const PrefixEditor = Rpc.define({
  id: "prefix-editor",
  methods: {
    getSystem: {
      input: object({ sessionID }),
      output: object({ sections: { type: "array", items: section }, hidden: { type: "array", items: edit } }),
      errors,
    },
    setSystem: { input: object({ sessionID, edits }), output: object({}) },
    // Leaves a one-line notice in the transcript that the model never sees.
    note: { input: object({ sessionID, description: { type: "string" } }), output: object({}) },
  },
  events: {},
})
