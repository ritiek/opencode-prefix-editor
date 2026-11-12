import type { SessionContext } from "@opencode/plugin/promise/session"
import type { Plugin } from "@opencode/plugin/tui"

/** A session as returned by the export API: its info plus every stored message. */
export type Transfer = Awaited<ReturnType<Plugin.Context["client"]["experimental"]["session"]["export"]>>
type Stored = Transfer["messages"][number]
type Assistant = Extract<Stored, { type: "assistant" }>
type Part = Assistant["content"][number]
type Tool = Extract<Part, { type: "tool" }>
type SystemPart = SessionContext["system"][number]

/** System prompt sections; refs index the parts OpenCode generates for each request. */
export type SystemSpec = { ref?: number; text: string }[]
type PartSpec = { ref?: [number, number]; kind: string; label?: string; body: string }
type MessageSpec = { ref?: number; type: string; label?: string; body: string; parts: PartSpec[] }
/** The editable text, structured. Refs index the original messages, which supply every field the text omits. */
export type Prefix = { system: SystemSpec; messages: MessageSpec[] }

// A ref'd header may carry a label (tool name, command, ...) that parse() ignores.
const MESSAGE = /^=== (?:([a-z][a-z-]*) #(\d+)(?: .*)?|([a-z][a-z-]*)) ===$/
const PART = /^--- (?:([a-z][a-z-]*) #(\d+)\.(\d+)(?: .*)?|([a-z][a-z-]*)) ---$/

// Editors disagree about blank lines at the end of a file, so trailing whitespace never counts as an edit.
const same = (a: string, b: string) => a.trimEnd() === b.trimEnd()
// Edited text keeps the original's trailing whitespace, which matters where parts are joined.
const retext = (orig: string, edited: string) => edited.trimEnd() + orig.slice(orig.trimEnd().length)

function json(body: string, name: string) {
  try {
    return JSON.parse(body)
  } catch (e) {
    throw new Error(`Invalid JSON in ${name}: ${(e as Error).message}`)
  }
}

// --- System prompt (applied per request by the server part) ---

export const systemSpec = (parts: SystemPart[]): SystemSpec => parts.map((part, ref) => ({ ref, text: part.text }))

export function resolveSystem(spec: SystemSpec, orig: SystemPart[]): SystemPart[] {
  return spec.map(({ ref, text }) => {
    const part = orig[ref ?? -1]
    if (!part) return { type: "text", text }
    return same(part.text, text) ? part : { ...part, text: retext(part.text, text) }
  })
}

// --- Stored messages ---

// The single editable field of non-assistant messages. Others (idle, shell, ...) can only be kept or deleted.
function textOf(m: Stored): string | undefined {
  if (m.type === "user" || m.type === "synthetic" || m.type === "system" || m.type === "skill") return m.text
  if (m.type === "compaction" && m.status === "completed") return m.summary
}

function label(m: Stored): string | undefined {
  if (m.type === "shell") return m.command.split("\n")[0]
  if (m.type === "agent-switched") return m.agent
  if (m.type === "model-switched") return `${m.model.providerID}/${m.model.id}`
}

const rawOutput = (t: Tool) =>
  t.state.status === "completed" && t.state.content.length === 1 && t.state.content[0]!.type === "text"

// Completed tool output: a lone text result is edited as-is, anything else as JSON.
function output(t: Tool): string | undefined {
  if (t.state.status !== "completed") return
  const [first] = t.state.content
  return rawOutput(t) && first?.type === "text" ? first.text : JSON.stringify(t.state.content, null, 2)
}

function sections(p: Part, ref: [number, number]): PartSpec[] {
  if (p.type === "text" || p.type === "reasoning") return [{ ref, kind: p.type, body: p.text }]
  if (p.type !== "tool") return [{ ref, kind: (p as { type: string }).type, body: "" }]
  const out = output(p)
  return [
    { ref, kind: "tool-input", label: p.name, body: JSON.stringify(p.state.input, null, 2) },
    ...(out === undefined ? [] : [{ ref, kind: "tool-output", label: p.name, body: out }]),
  ]
}

/** The session as editable structure: the system prompt followed by every stored message. */
export function current(messages: Stored[], system: SystemSpec): Prefix {
  return {
    system,
    messages: messages.map((m, i) => ({
      ref: i,
      type: m.type,
      label: label(m),
      body: textOf(m) ?? "",
      parts: m.type === "assistant" ? m.content.flatMap((p, j) => sections(p, [i, j])) : [],
    })),
  }
}

const random = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[b % 62]).join("")
/** Ids only have to be unique (stored order follows position), so keep the original's time part and reroll the rest. */
export const freshId = (id: string) => id.slice(0, -14) + random(14)

function withTool(t: Tool, p: PartSpec, name: string): Tool {
  if (p.kind === "tool-input")
    return same(JSON.stringify(t.state.input, null, 2), p.body) ? t : ({ ...t, native: undefined, state: { ...t.state, input: json(p.body, name) } } as Tool)
  const out = output(t)
  if (out === undefined) throw new Error(`${name} has no output to edit`)
  if (same(out, p.body)) return t
  const content = rawOutput(t) ? [{ type: "text", text: p.body }] : json(p.body, name)
  return { ...t, native: undefined, state: { ...t.state, content } } as Tool
}

function assistantContent(m: MessageSpec, orig: Stored[]): Part[] {
  const content: Part[] = []
  const tools = new Map<string, number>() // a tool's input and output sections update one part
  for (const p of m.parts) {
    const at = p.ref && orig[p.ref[0]]
    const o = at && at.type === "assistant" ? at.content[p.ref![1]] : undefined
    const name = `${p.kind} #${p.ref?.join(".")}`
    if (p.kind === "text" && o?.type !== "text") content.push({ type: "text", text: p.body })
    else if (!o || o.type !== (p.kind.startsWith("tool-") ? "tool" : p.kind)) throw new Error(`Unknown part: ${name}`)
    else if (o.type === "text" || o.type === "reasoning")
      content.push(same(o.text, p.body) ? o : { ...o, text: retext(o.text, p.body), native: undefined })
    else if (o.type !== "tool") content.push(o)
    else {
      const key = p.ref!.join()
      if (!tools.has(key)) tools.set(key, content.push(o) - 1)
      const i = tools.get(key)!
      content[i] = withTool(content[i] as Tool, p, name)
    }
  }
  return content
}

/** The stored messages for the edited text, with fresh ids. Unchanged messages and parts are copied verbatim. */
export function rebuild(specs: MessageSpec[], orig: Stored[]): Stored[] {
  return specs.flatMap((m): Stored[] => {
    if (m.ref === undefined) {
      if (m.type !== "user") throw new Error(`Only new user messages can be added, not "${m.type}"`)
      return m.body.trim() ? [{ type: "user", id: `msg_${random(26)}`, time: { created: Date.now() }, text: m.body }] : []
    }
    const o = orig[m.ref]
    if (o?.type !== m.type) throw new Error(`Unknown message: ${m.type} #${m.ref}`)
    const id = freshId(o.id)
    if (o.type === "assistant") {
      const content = assistantContent(m, orig)
      if (!content.length) return [] // cleared
      const changed = content.length !== o.content.length || content.some((p, j) => p !== o.content[j])
      // native holds provider replay data, which would win over edited content
      return [changed ? { ...o, id, content, native: undefined } : { ...o, id }]
    }
    const text = textOf(o)
    if (text === undefined) {
      if (m.body.trim()) throw new Error(`${m.type} #${m.ref} has no editable text`)
      return [{ ...o, id }]
    }
    if (!m.body.trim()) return [] // cleared
    if (same(text, m.body)) return [{ ...o, id }]
    const edited = retext(text, m.body)
    return [(o.type === "compaction" ? { ...o, id, summary: edited, native: undefined } : { ...o, id, text: edited }) as Stored]
  })
}

// --- Text ---

const tag = (ref?: number | number[], label?: string) =>
  ref === undefined ? "" : ` #${[ref].flat().join(".")}${label ? ` ${label}` : ""}`
// Text right under an assistant header is that message's first text part.
const head = (ref?: number): [number, number] | undefined => (ref === undefined ? undefined : [ref, 0])
const isHeader = (line: string) => MESSAGE.test(line) || PART.test(line)
// Body lines that would read as headers get one more leading backslash, which parse() removes again.
const escaped = (line: string) => isHeader(line.replace(/^\\+/, ""))
const escape = (body: string) => body.replace(/^.*$/gm, (line) => (escaped(line) ? `\\${line}` : line))
const unescape = (line: string) => (line.startsWith("\\") && escaped(line) ? line.slice(1) : line)
const chunk = (header: string, body: string) => (body ? `${header}\n${escape(body)}\n\n` : `${header}\n`)

export function render({ system, messages }: Prefix): string {
  return [
    ...system.map((s) => chunk(`=== system-prompt${tag(s.ref)} ===`, s.text)),
    ...messages.map((m) => {
      const [first, ...rest] = m.parts
      const inline = first?.kind === "text" && first.ref?.join() === head(m.ref)?.join()
      return (
        chunk(`=== ${m.type}${tag(m.ref, m.label)} ===`, inline ? first.body : m.body) +
        (inline ? rest : m.parts).map((p) => chunk(`--- ${p.kind}${tag(p.ref, p.label)} ---`, p.body)).join("")
      )
    }),
  ].join("")
}

export function parse(text: string): Prefix {
  const chunks: { header: string; line: number; lines: string[] }[] = []
  text.split("\n").forEach((line, i) => {
    if (isHeader(line)) chunks.push({ header: line, line: i + 1, lines: [] })
    else if (chunks.length) chunks.at(-1)!.lines.push(unescape(line))
    else if (line.trim()) throw new Error(`Line ${i + 1}: expected a "=== <type> ===" header`)
  })

  const prefix: Prefix = { system: [], messages: [] }
  let message: MessageSpec | undefined
  for (const { header, line, lines } of chunks) {
    const body = lines.join("\n").trimEnd()
    const m = MESSAGE.exec(header)
    if (m) {
      const type = m[1] ?? m[3]!
      const ref = m[2] === undefined ? undefined : Number(m[2])
      if (type === "system-prompt") {
        message = undefined
        if (body.trim()) prefix.system.push({ ref, text: body })
      } else {
        message = { ref, type, body: type === "assistant" ? "" : body, parts: [] }
        prefix.messages.push(message)
        if (type === "assistant" && body.trim()) message.parts.push({ ref: head(ref), kind: "text", body })
      }
      continue
    }
    if (message?.type !== "assistant") throw new Error(`Line ${line}: "${header}" must follow an assistant message header`)
    const p = PART.exec(header)!
    const kind = p[1] ?? p[4]!
    if (p[2] === undefined && kind !== "text") throw new Error(`Line ${line}: only new text parts can be added, not "${kind}"`)
    // Blank text is dropped, so clearing a part deletes it.
    if (kind !== "text" || body.trim()) message.parts.push({ ref: p[2] === undefined ? undefined : [Number(p[2]), Number(p[3])], kind, body })
  }
  return prefix
}
