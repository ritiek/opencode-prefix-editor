import { describe, expect, test } from "bun:test"
import { current, parse, rebuild, render, resolveSystem, systemSpec, type Transfer } from "../src/format.ts"

type Stored = Transfer["messages"][number]
const time = { created: 1 }
const model = { providerID: "anthropic", id: "claude" }

const messages = (): Stored[] =>
  [
    { type: "user", id: "msg_000000000001aaaaaaaaaaaaaa", time, text: "fix the bug\n", files: [{ uri: "file:///a.png" }] },
    { type: "synthetic", id: "msg_000000000002aaaaaaaaaaaaaa", time, text: "<system-reminder>plan mode</system-reminder>" },
    {
      type: "assistant",
      id: "msg_000000000003aaaaaaaaaaaaaa",
      time,
      agent: "build",
      model,
      native: { anthropic: { container: "c" } },
      content: [
        { type: "reasoning", text: "thinking", native: { signature: "sig" } },
        { type: "text", text: "Looking." },
        { type: "tool", id: "c1", name: "read", time, state: { status: "completed", input: { path: "a.ts" }, content: [{ type: "text", text: "const a = 1\n" }] } },
        { type: "tool", id: "c2", name: "bash", time, state: { status: "completed", input: { command: "bun test" }, content: [{ type: "text", text: "a" }, { type: "file", uri: "file:///b", mime: "image/png" }] } },
        { type: "tool", id: "c3", name: "bash", time, state: { status: "error", input: { command: "false" }, error: { message: "exit 1" } } },
      ],
    },
    { type: "idle", id: "msg_000000000004aaaaaaaaaaaaaa", time, outcome: "succeeded" },
    { type: "model-switched", id: "msg_000000000005aaaaaaaaaaaaaa", time, model },
    // Header-looking lines inside a message must survive the round trip.
    { type: "user", id: "msg_000000000006aaaaaaaaaaaaaa", time, text: "what is this?\n=== user ===\n--- text ---\n\\=== tool #2 ===" },
    { type: "compaction", id: "msg_000000000007aaaaaaaaaaaaaa", time, status: "completed", reason: "auto", summary: "## Objective", native: { x: 1 } },
  ] as never

const system = [{ type: "text" as const, text: "You are an agent.", cache: { type: "ephemeral" as const } }, { type: "text" as const, text: "Env: linux\n" }]
const text = (m = messages()) => render(current(m, systemSpec(system as never)))
const withoutIds = (list: Stored[]) => list.map(({ id: _, ...rest }) => rest)

describe("round trip", () => {
  test("unchanged text rebuilds the same messages under fresh ids", () => {
    const m = messages()
    const out = rebuild(parse(text(m)).messages, m)
    expect(withoutIds(out)).toEqual(withoutIds(m))
    out.forEach((msg, i) => {
      expect(msg.id).not.toBe(m[i]!.id)
      expect(msg.id.slice(0, 16)).toBe(m[i]!.id.slice(0, 16))
    })
    // Untouched parts are the very same objects, so nothing about them changes on the wire.
    expect((out[2] as never as { content: unknown[] }).content[0]).toBe((m[2] as never as { content: unknown[] }).content[0])
  })

  test("renders readable sections", () => {
    expect(text()).toMatchSnapshot()
  })

  test("trailing whitespace is not an edit", () => {
    const m = messages()
    for (const variant of [text(m).replace(/\n+$/, ""), `${text(m)}\n\n`, text(m).replaceAll("\n\n=", "\n=")])
      expect(withoutIds(rebuild(parse(variant).messages, m))).toEqual(withoutIds(m))
  })
})

describe("edits", () => {
  const m = messages()
  const edited = text(m)
    .replace("fix the bug\n", "fix the bug in a.ts\n")
    .replace("Looking.", "Reading a.ts.")
    .replace("thinking", "thought")
    .replace('"path": "a.ts"', '"path": "b.ts"')
    .replace("const a = 1\n", "[pruned]")
    .replace("=== idle #3 ===\n", "")
    .replace("## Objective", "## Goal")
  const out = rebuild(parse(edited).messages, m) as never as Record<string, any>[]

  test("text edits keep other fields and the original trailing whitespace", () => {
    expect(out[0]).toMatchObject({ type: "user", text: "fix the bug in a.ts\n", files: [{ uri: "file:///a.png" }] })
  })

  test("assistant edits drop provider replay data so the model sees them", () => {
    const content = out[2]!.content
    expect(out[2]!.native).toBeUndefined()
    expect(content[0]).toEqual({ type: "reasoning", text: "thought", native: undefined })
    expect(content[1]).toEqual({ type: "text", text: "Reading a.ts.", native: undefined })
    expect(content[2].state).toEqual({ status: "completed", input: { path: "b.ts" }, content: [{ type: "text", text: "[pruned]" }] })
  })

  test("deleting a header drops the message", () => {
    expect(out.map((msg) => msg.type)).toEqual(["user", "synthetic", "assistant", "model-switched", "user", "compaction"])
  })

  test("compaction summaries are editable", () => {
    expect(out[5]).toMatchObject({ summary: "## Goal", native: undefined })
  })

  test("a tool part stays until both of its sections are deleted", () => {
    const outputGone = text(m).replace(/--- tool-output #2\.2 read ---\nconst a = 1\n\n/, "")
    expect((rebuild(parse(outputGone).messages, m)[2] as never as { content: unknown[] }).content).toHaveLength(5)
    const bothGone = outputGone.replace(/--- tool-input #2\.2 read ---\n[\s\S]*?\n\n(?=---)/, "")
    expect((rebuild(parse(bothGone).messages, m)[2] as never as { content: unknown[] }).content).toHaveLength(4)
  })

  test("new user messages and text parts can be added; cleared messages are deleted", () => {
    const more = text(m)
      .replace("fix the bug\n", "")
      .replace("=== idle #3 ===", "--- text ---\nadded part\n\n=== user ===\nnew message\n\n=== idle #3 ===")
    const res = rebuild(parse(more).messages, m) as never as Record<string, any>[]
    expect(res.map((msg) => msg.type)).toEqual(["synthetic", "assistant", "user", "idle", "model-switched", "user", "compaction"])
    expect(res[1]!.content.at(-1)).toEqual({ type: "text", text: "added part" })
    expect(res[2]).toMatchObject({ type: "user", text: "new message" })
    expect(res[2]!.id).toMatch(/^msg_\w{26}$/)
  })
})

describe("errors", () => {
  const m = messages()
  const t = text(m)
  const fails = (edited: string, message: string) => expect(() => rebuild(parse(edited).messages, m)).toThrow(message)

  test("invalid JSON names the section", () => fails(t.replace('"path": "a.ts"', "path: a.ts"), "Invalid JSON in tool-input #2.2"))
  test("unknown refs are rejected", () => fails(t.replace("--- tool-input #2.2 read ---", "--- tool-input #9.9 ---"), "Unknown part"))
  test("a ref must match its message type", () => fails(t.replace("=== synthetic #1 ===", "=== user #1 ==="), "Unknown message: user #1"))
  test("only user messages can be new", () => fails(`${t}=== assistant ===\nhi\n`, 'Only new user messages can be added, not "assistant"'))
  test("markers have no text", () => fails(t.replace("=== idle #3 ===", "=== idle #3 ===\nhello"), "idle #3 has no editable text"))
  test("parts only belong to assistant messages", () => expect(() => parse(t.replace("=== synthetic #1 ===", "=== synthetic #1 ===\n--- text ---"))).toThrow("must follow an assistant"))
  test("text before the first header is rejected", () => expect(() => parse(`oops\n${t}`)).toThrow("Line 1"))
})

describe("system prompt", () => {
  test("unchanged sections resolve to the generated parts", () => {
    const resolved = resolveSystem(parse(text()).system, system as never)
    resolved.forEach((part, i) => expect(part).toBe(system[i]!))
  })

  test("edits keep other fields and trailing whitespace; new sections are plain text", () => {
    const spec = parse(text().replace("You are an agent.", "You are a pirate.").replace("Env: linux", "Env: mac") + "=== system-prompt ===\nBe brief.\n").system
    expect(resolveSystem(spec, system as never)).toEqual([
      { type: "text", text: "You are a pirate.", cache: { type: "ephemeral" } },
      { type: "text", text: "Env: mac\n" },
      { type: "text", text: "Be brief." },
    ])
  })
})
