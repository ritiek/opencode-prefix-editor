import { Rpc } from "@opencode/plugin/rpc"

const object = (properties: Record<string, object>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false }) as const
const sessionID = { type: "string" }
// Ids of the messages the rendered text covers; sent back on apply to detect a history that changed meanwhile.
const ids = { type: "array", items: { type: ["string", "null"] } }
const errors = { failed: { type: "object" } } as const

export type Ids = (string | null)[]

export const PrefixEditor = Rpc.define({
  id: "prefix-editor",
  methods: {
    render: { input: object({ sessionID }), output: object({ text: { type: "string" }, ids }), errors },
    apply: { input: object({ sessionID, text: { type: "string" }, ids }), output: object({}), errors },
    reset: { input: object({ sessionID }), output: object({}) },
  },
  events: {},
})
