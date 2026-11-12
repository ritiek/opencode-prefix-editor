import { Rpc } from "@opencode/plugin/rpc"

const object = (properties: Record<string, object>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false }) as const
const sessionID = { type: "string" }
// SystemSpec: system prompt sections, each optionally tied to the generated part it replaces.
const system = {
  type: "array",
  items: { type: "object", properties: { ref: { type: "integer" }, text: { type: "string" } }, required: ["text"] },
}
const errors = { failed: { type: "object" } } as const

// The system prompt is not stored in the session, so the server part overrides it per request.
export const PrefixEditor = Rpc.define({
  id: "prefix-editor",
  methods: {
    getSystem: { input: object({ sessionID }), output: object({ system }), errors },
    setSystem: { input: object({ sessionID, system }), output: object({}), errors },
  },
  events: {},
})
