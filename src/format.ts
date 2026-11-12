import type { SessionContext } from "@opencode/plugin/promise/session"
import type { Ids } from "./rpc.ts"

type Message = SessionContext["messages"][number]
type Part = Message["content"][number]
type ToolResult = Extract<Part, { type: "tool-result" }>
export type Request = Pick<SessionContext, "system" | "messages">

type PartSpec = { ref?: [number, number]; type: string; body: string }
type MessageSpec = { ref?: number; role: Message["role"]; parts: PartSpec[] }
/** An editable prefix. Refs index the original request, so fields the text omits can be restored from it. */
export type Prefix = { system: { ref?: number; text: string }[]; messages: MessageSpec[] }
/** A stored edit: its messages stand in for the original messages whose ids are listed. */
export type Spec = Prefix & { ids: Ids }

const MESSAGE = /^=== (system prompt|system|user|assistant|tool)(?: #(\d+))? ===$/
const PART = /^--- (?:([a-z][a-z-]*) #(\d+)\.(\d+)|text) ---$/

export const ids = (messages: Message[]): Ids => messages.map((m) => m.id ?? null)

/** True when the history no longer starts with the messages the edit was made against (compaction, revert). */
export const stale = (spec: Spec, orig: Request) =>
  orig.messages.length < spec.ids.length || spec.ids.some((id, i) => (orig.messages[i]!.id ?? null) !== id)

const rawText = (part: ToolResult) => part.result.type === "text" && typeof part.result.value === "string"
// Editors disagree about blank lines at the end of a file, so trailing whitespace never counts as an edit.
const same = (a: string, b: string) => a.trimEnd() === b.trimEnd()
// Edited text keeps the original's trailing whitespace, which matters where parts are joined.
const retext = (orig: string, edited: string) => edited.trimEnd() + orig.slice(orig.trimEnd().length)

// Text and reasoning are edited as-is, tool payloads as JSON; other parts (media, ...) are only kept or dropped.
function encode(part: Part): string {
  if (part.type === "text" || part.type === "reasoning") return part.text
  if (part.type === "tool-call") return JSON.stringify(part.input, null, 2)
  if (part.type === "tool-result") return rawText(part) ? String(part.result.value) : JSON.stringify(part.result.value, null, 2)
  return ""
}

function decode(spec: PartSpec, orig: Part | undefined): Part {
  if (spec.type === "text" && orig?.type !== "text") return { type: "text", text: spec.body }
  const name = `${spec.type} #${spec.ref?.join(".")}`
  if (orig?.type !== spec.type) throw new Error(`Unknown part: ${name}`)
  if (same(spec.body, encode(orig))) return orig
  if (orig.type === "text" || orig.type === "reasoning") return { ...orig, text: retext(orig.text, spec.body) }
  try {
    if (orig.type === "tool-call") return { ...orig, input: JSON.parse(spec.body) }
    if (orig.type === "tool-result")
      return { ...orig, result: { ...orig.result, value: rawText(orig) ? spec.body : JSON.parse(spec.body) } } as ToolResult
  } catch (e) {
    throw new Error(`Invalid JSON in ${name}: ${(e as Error).message}`)
  }
  return orig
}

/** The request the model sees: the edited prefix followed by the original messages it does not cover. */
export function resolve(spec: Spec, orig: Request): Request {
  return {
    system: spec.system.map(({ ref, text }) => {
      const part = orig.system[ref ?? -1]
      if (!part) return { type: "text" as const, text }
      return same(part.text, text) ? part : { ...part, text: retext(part.text, text) }
    }),
    messages: [
      ...spec.messages.map(({ ref, role, parts }) => {
        const content = parts.map((p) => decode(p, p.ref && orig.messages[p.ref[0]]?.content[p.ref[1]]))
        return { ...orig.messages[ref ?? -1], role, content } as Message
      }),
      ...orig.messages.slice(spec.ids.length),
    ],
  }
}

/** What the model currently sees, as an editable prefix: the stored edit (if any) plus every message after it. */
export function current(orig: Request, spec?: Spec): Prefix {
  const from = spec?.ids.length ?? 0
  const rest = orig.messages.slice(from).map((m, k) => {
    const i = from + k
    return { ref: i, role: m.role, parts: m.content.map((p, j) => ({ ref: [i, j] as [number, number], type: p.type, body: encode(p) })) }
  })
  return {
    system: spec?.system ?? orig.system.map((part, ref) => ({ ref, text: part.text })),
    messages: [...(spec?.messages ?? []), ...rest],
  }
}

const tag = (ref?: number | number[]) => (ref === undefined ? "" : ` #${[ref].flat().join(".")}`)
// Text written directly under a message header maps back to that message's first part.
const head = (ref?: number): [number, number] | undefined => (ref === undefined ? undefined : [ref, 0])
const isHeader = (line: string) => MESSAGE.test(line) || PART.test(line)
// Body lines that would read as headers get one more leading backslash, which parse() removes again.
const escaped = (line: string) => isHeader(line.replace(/^\\+/, ""))
const escape = (body: string) => body.replace(/^.*$/gm, (line) => (escaped(line) ? `\\${line}` : line))
const unescape = (line: string) => (line.startsWith("\\") && escaped(line) ? line.slice(1) : line)
const chunk = (header: string, body: string) => (body ? `${header}\n${escape(body)}\n\n` : `${header}\n`)

export function render({ system, messages }: Prefix): string {
  return [
    ...system.map((s) => chunk(`=== system prompt${tag(s.ref)} ===`, s.text)),
    ...messages.map((m) => {
      const [first, ...rest] = m.parts
      const inline = first?.type === "text" && first.ref?.join() === head(m.ref)?.join()
      return (
        chunk(`=== ${m.role}${tag(m.ref)} ===`, inline ? first.body : "") +
        (inline ? rest : m.parts).map((p) => chunk(p.ref ? `--- ${p.type}${tag(p.ref)} ---` : "--- text ---", p.body)).join("")
      )
    }),
  ].join("")
}

export function parse(text: string): Prefix {
  const chunks: { header: string; line: number; lines: string[] }[] = []
  text.split("\n").forEach((line, i) => {
    if (isHeader(line)) chunks.push({ header: line, line: i + 1, lines: [] })
    else if (chunks.length) chunks.at(-1)!.lines.push(unescape(line))
    else if (line.trim()) throw new Error(`Line ${i + 1}: expected a "=== <role> ===" header`)
  })

  const prefix: Prefix = { system: [], messages: [] }
  let message: MessageSpec | undefined
  for (const { header, line, lines } of chunks) {
    const body = lines.join("\n").trimEnd()
    const m = MESSAGE.exec(header)
    if (m) {
      const ref = m[2] === undefined ? undefined : Number(m[2])
      if (m[1] === "system prompt") {
        message = undefined
        if (body.trim()) prefix.system.push({ ref, text: body })
      } else {
        message = { ref, role: m[1] as Message["role"], parts: [] }
        prefix.messages.push(message)
        if (body.trim()) message.parts.push({ ref: head(ref), type: "text", body })
      }
      continue
    }
    if (!message) throw new Error(`Line ${line}: "${header}" must follow a message header`)
    const [, type = "text", i, j] = PART.exec(header)!
    if (type !== "text" || body.trim()) message.parts.push({ ref: i === undefined ? undefined : [Number(i), Number(j)], type, body })
  }
  // Blank text is dropped, so clearing a message (or system prompt section) deletes it.
  prefix.messages = prefix.messages.filter((m) => m.parts.length)
  return prefix
}

/** Turns edited text into a stored edit, checked against the history `base` was rendered from. */
export function edit(text: string, orig: Request, base: Ids): Spec {
  const spec = { ...parse(text), ids: base }
  if (stale(spec, orig)) throw new Error("The session history changed while editing; run the command again")
  resolve(spec, orig)
  return spec
}
