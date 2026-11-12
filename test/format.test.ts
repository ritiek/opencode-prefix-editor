import { describe, expect, test } from "bun:test"
import { current, edit, ids, parse, render, resolve, stale, type Request } from "../src/format.ts"

const request = (): Request =>
  ({
    system: [
      { type: "text", text: "You are a helpful agent.", cache: { type: "ephemeral" } },
      { type: "text", text: "Env: linux\n", metadata: { source: "env" } },
    ],
    messages: [
      { id: "m0", role: "user", content: [{ type: "text", text: "fix the bug\n" }] },
      {
        id: "m1",
        role: "assistant",
        content: [
          { type: "reasoning", text: "", encrypted: "sig" },
          { type: "text", text: "Looking.", providerMetadata: { openai: { itemId: "x" } } },
          { type: "tool-call", id: "c1", name: "read", input: { path: "a.ts" } },
          { type: "tool-call", id: "c2", name: "bash", input: { command: "bun test" } },
        ],
      },
      {
        id: "m2",
        role: "tool",
        content: [
          { type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "const a = 1\n" } },
          { type: "tool-result", id: "c2", name: "bash", result: { type: "json", value: { out: "=== 3 passed ===\n--- end ---" } } },
        ],
      },
      {
        id: "m3",
        role: "user",
        content: [
          { type: "media", media: { source: { type: "bytes", data: new Uint8Array([1, 2]), mediaType: "image/png" } } },
          { type: "text", text: "what is this?" },
        ],
      },
    ],
  }) as never

const base = (r: Request) => ids(r.messages)

describe("round trip", () => {
  test("unchanged text resolves to the original request", () => {
    const r = request()
    const text = render(current(r))
    expect(resolve(edit(text, r, base(r)), r)).toEqual(r)
    // Untouched parts keep their identity, so nothing about them changes on the wire.
    expect(resolve(edit(text, r, base(r)), r).messages[3]!.content[0]).toBe(r.messages[3]!.content[0]!)
  })

  test("renders readable sections", () => {
    expect(render(current(request()))).toMatchSnapshot()
  })

  test("trailing whitespace is not an edit", () => {
    const r = request()
    const text = render(current(r))
    for (const variant of [text.replace(/\n+$/, ""), `${text}\n\n`, text.replaceAll("\n\n=", "\n=")]) {
      const out = resolve(edit(variant, r, base(r)), r)
      expect(out).toEqual(r)
      expect(out.system[1]).toBe(r.system[1]!)
      expect(out.messages[0]!.content[0]).toBe(r.messages[0]!.content[0]!)
    }
  })
})

describe("edits", () => {
  const r = request()
  const text = render(current(r))
    .replace("You are a helpful agent.", "You are a pirate.")
    .replace("Env: linux", "Env: mac")
    .replace("const a = 1\n", "[pruned]")
    .replace('"command": "bun test"', '"command": "bun test --bail"')
    .replace("=== user #0 ===\nfix the bug\n", "=== user #0 ===\nfix the bug in a.ts\n")
    .replace(/=== user #3 ===[\s\S]*$/, "=== user ===\nnew message\n")
  const spec = edit(text, r, base(r))
  const out = resolve(spec, r)

  test("system prompt keeps its other fields", () => {
    expect(out.system[0]).toEqual({ type: "text", text: "You are a pirate.", cache: { type: "ephemeral" } })
    // Trailing whitespace of the original survives, since system parts are joined.
    expect(out.system[1]).toEqual({ type: "text", text: "Env: mac\n", metadata: { source: "env" } })
  })

  test("text, tool input and tool output are replaced", () => {
    expect(out.messages[0]!.content[0]).toEqual({ type: "text", text: "fix the bug in a.ts\n" })
    expect(out.messages[1]!.content[3]).toMatchObject({ input: { command: "bun test --bail" } })
    expect(out.messages[2]!.content[0]).toMatchObject({ result: { type: "text", value: "[pruned]" } })
  })

  test("messages can be removed and added", () => {
    expect(out.messages).toHaveLength(4)
    expect(out.messages[3]).toEqual({ role: "user", content: [{ type: "text", text: "new message" }] } as never)
  })

  test("clearing a message deletes it", () => {
    const cleared = render(current(r)).replace("fix the bug\n", "")
    expect(resolve(edit(cleared, r, base(r)), r).messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"])
  })

  test("is sticky: later messages are appended after the edited prefix", () => {
    const grown = { ...r, messages: [...r.messages, { id: "m4", role: "assistant", content: [{ type: "text", text: "Arr." }] }] } as Request
    expect(stale(spec, grown)).toBe(false)
    expect(resolve(spec, grown).messages.map((m) => m.id ?? "new")).toEqual(["m0", "m1", "m2", "new", "m4"])
  })

  test("re-editing starts from the edited prefix", () => {
    const grown = { ...r, messages: [...r.messages, { id: "m4", role: "assistant", content: [{ type: "text", text: "Arr." }] }] } as Request
    const again = render(current(grown, spec))
    expect(again).toContain("You are a pirate.")
    expect(again).toContain("=== assistant #4 ===\nArr.")
    expect(resolve(edit(again, grown, base(grown)), grown)).toEqual(resolve(spec, grown))
  })
})

describe("errors", () => {
  const r = request()
  const text = render(current(r))

  test("invalid JSON names the part", () => {
    expect(() => edit(text.replace('"path": "a.ts"', "path: a.ts"), r, base(r))).toThrow("Invalid JSON in tool-call #1.2")
  })

  test("unknown refs are rejected", () => {
    expect(() => edit(text.replace("--- tool-call #1.2 ---", "--- tool-call #9.9 ---"), r, base(r))).toThrow("Unknown part")
  })

  test("text before the first header is rejected", () => {
    expect(() => parse(`oops\n${text}`)).toThrow("Line 1")
  })

  test("a history that changed meanwhile is rejected and marks edits stale", () => {
    const compacted = { ...r, messages: [{ id: "summary", role: "user", content: [{ type: "text", text: "..." }] }, ...r.messages.slice(1)] } as Request
    expect(() => edit(text, compacted, base(r))).toThrow("history changed")
    expect(stale(edit(text, r, base(r)), compacted)).toBe(true)
    expect(stale(edit(text, r, base(r)), { ...r, messages: r.messages.slice(0, 2) })).toBe(true)
  })
})
