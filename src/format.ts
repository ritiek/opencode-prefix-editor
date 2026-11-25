import type { SessionContext } from "@opencode/plugin/promise/session"
import type { Plugin } from "@opencode/plugin/tui"

/** A session as returned by the export API: its info plus every stored message. */
export type Transfer = Awaited<ReturnType<Plugin.Context["client"]["experimental"]["session"]["export"]>>
type Stored = Transfer["messages"][number]
type Assistant = Extract<Stored, { type: "assistant" }>
type Part = Assistant["content"][number]
type Tool = Extract<Part, { type: "tool" }>
type SystemPart = SessionContext["system"][number]

/** System prompt sections as edited; refs index the sections they were rendered from. */
export type SystemSpec = { ref?: number; text: string; label?: string }[]
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

/**
 * What a system prompt section belongs to, so an edit follows its source instead of its position: the agent's own
 * prompt (used only while that agent runs), one instruction source by key, or another part by its generated text.
 */
export type Anchor = { agent: string } | { instruction: string } | { part: string }
/** A section as shown in the editor; inserted sections have no anchor. */
export type Section = { anchor?: Anchor; generated: string; text: string; label: string }
/** Stored system prompt edits: only the sources that differ from OpenCode's generated prompt (`null` deletes). */
export type SystemEdits = { edits: { anchor: Anchor; text: string | null }[]; inserted: string[] }
/** v0.2 stored every section's text by part index, which froze the whole prompt. Still honoured for old copies. */
type LegacySystem = { ref?: number; text: string }[]
export type StoredSystem = SystemEdits | LegacySystem

const SEPARATOR = "\n\n" // how OpenCode joins instruction sources
const sameAnchor = (a: Anchor, b: Anchor) => JSON.stringify(a) === JSON.stringify(b)
type Instruction = { key: string; text: string }
const instructionsOf = (part: SystemPart) =>
  (part.metadata as { experimental?: { instructions?: Instruction[] } } | undefined)?.experimental?.instructions

/** v0.2 copies froze every part; as whole-part edits they keep doing exactly that. */
const fromLegacy = (spec: LegacySystem, system: SystemPart[]): SystemEdits => ({
  edits: system.map((part, i) => {
    const text = spec.find((s) => s.ref === i)?.text
    return { anchor: { part: part.text }, text: text === undefined ? null : retext(part.text, text) }
  }),
  inserted: spec.filter((s) => s.ref === undefined || !system[s.ref]).map((s) => s.text),
})
const normalize = (stored: StoredSystem | undefined, system: SystemPart[]): SystemEdits =>
  Array.isArray(stored) ? fromLegacy(stored, system) : (stored ?? { edits: [], inserted: [] })
const finder = (stored: SystemEdits) => (anchor: Anchor) => stored.edits.find((e) => sameAnchor(e.anchor, anchor))

/**
 * OpenCode sends [agent prompt, instruction sources joined into one part, ...parts plugins add]. A part edited as a
 * whole (legacy copies) stays one section; otherwise the instructions part splits into one section per source.
 */
function sources(system: SystemPart[], agent: string, edit: ReturnType<typeof finder>): Omit<Section, "text">[] {
  return system.flatMap((part, i): Omit<Section, "text">[] => {
    const list = instructionsOf(part)
    const whole = { anchor: { part: part.text }, generated: part.text }
    if (edit(whole.anchor)) return [{ ...whole, label: "edited" }]
    if (list) return list.map(({ key, text }) => ({ anchor: { instruction: key }, generated: text, label: key }))
    if (i === 0) return [{ anchor: { agent }, generated: part.text, label: `agent ${agent}` }]
    return [{ ...whole, label: "plugin" }]
  })
}

/** The sections of the prompt in effect for `agent`: generated text with the stored edits applied. */
export function sections(system: SystemPart[], agent: string, stored?: StoredSystem): Section[] {
  const edits = normalize(stored, system)
  const edit = finder(edits)
  return [
    ...sources(system, agent, edit).flatMap((s) => {
      const e = edit(s.anchor!)
      return e?.text === null ? [] : [{ ...s, text: e?.text ?? s.generated }]
    }),
    ...edits.inserted.map((text) => ({ generated: "", text, label: "inserted" })),
  ]
}

/** Stored edits of a previous copy that the shown sections don't cover (another agent's prompt, a changed plugin part). */
export const hiddenEdits = (shown: Section[], stored: StoredSystem | undefined, system: SystemPart[]): SystemEdits["edits"] =>
  normalize(stored, system).edits.filter((e) => e.text === null || !shown.some((s) => s.anchor && sameAnchor(s.anchor, e.anchor)))

/** The edits to store for `edited`, made from the rendered `shown` sections. Unchanged sources stay live. */
export function diffSystem(shown: Section[], edited: SystemSpec, hidden: SystemEdits["edits"] = []): SystemEdits {
  const byRef = new Map(edited.flatMap((s) => (s.ref === undefined ? [] : [[s.ref, s.text] as const])))
  const edits = shown.flatMap((s, i): SystemEdits["edits"] => {
    if (!s.anchor) return []
    const text = byRef.get(i)
    if (text === undefined) return [{ anchor: s.anchor, text: null }]
    return same(text, s.generated) ? [] : [{ anchor: s.anchor, text: retext(s.generated, text) }]
  })
  const inserted = edited.flatMap((s) => (s.ref === undefined || !shown[s.ref]?.anchor ? [s.text] : []))
  const covered = (e: { anchor: Anchor }) => edits.some((x) => sameAnchor(x.anchor, e.anchor))
  return { edits: [...edits, ...hidden.filter((e) => !covered(e))], inserted }
}

export const isEmpty = (s: SystemEdits) => !s.edits.length && !s.inserted.length

// Edits one instruction source inside the joined part, searching forward so a source quoting another isn't hit.
function withInstructions(part: SystemPart, list: Instruction[], edit: (a: Anchor) => SystemEdits["edits"][number] | undefined) {
  if (!list.some((i) => edit({ instruction: i.key }))) return part
  let text = part.text
  let cursor = 0
  const kept: Instruction[] = []
  for (const inst of list) {
    const at = text.indexOf(inst.text, cursor)
    const e = edit({ instruction: inst.key })
    if (!e || at < 0) {
      if (at >= 0) cursor = at + inst.text.length
      kept.push(inst)
      continue
    }
    const end = at + inst.text.length
    if (e.text === null) {
      const [from, to] = text.startsWith(SEPARATOR, end) ? [at, end + SEPARATOR.length] : text.slice(0, at).endsWith(SEPARATOR) ? [at - SEPARATOR.length, end] : [at, end]
      text = text.slice(0, from) + text.slice(to)
      cursor = from
    } else {
      text = text.slice(0, at) + e.text + text.slice(end)
      cursor = at + e.text.length
      kept.push({ ...inst, text: e.text })
    }
  }
  // Keep the metadata copy in step: some providers read the sources from it instead of the text.
  const meta = part.metadata as { experimental?: object } | undefined
  return { ...part, text, metadata: { ...meta, experimental: { ...meta?.experimental, instructions: kept } } }
}

/** The system prompt to send: the generated one with the stored edits applied to their sources. */
export function resolveSystem(stored: StoredSystem, system: SystemPart[], agent: string): SystemPart[] {
  const edits = normalize(stored, system)
  const edit = finder(edits)
  const parts = system.flatMap((part, i): SystemPart[] => {
    const list = instructionsOf(part)
    const e = edit({ part: part.text }) ?? (!list && i === 0 ? edit({ agent }) : undefined)
    if (e) return e.text === null ? [] : [{ ...part, text: e.text }]
    return list ? [withInstructions(part, list, edit)] : [part]
  })
  return [...parts, ...edits.inserted.map((text) => ({ type: "text" as const, text }))].filter((p) => p.text.length)
}

// --- Stored messages ---

/** Metadata marking the user message /edit-prefix <instruction> sends the model. */
export const REQUEST = { prefixEditor: "request" } as const

/** Metadata marking the notice left in a session a copy was made from. */
export const NOTE = { prefixEditor: "note" } as const

/**
 * Drops plugin plumbing from history: the notices left on saving, and each /edit-prefix request v0.2 sent with the
 * turn it started (up to the next user message).
 */
export function withoutRequests(messages: Stored[]): Stored[] {
  let inRequest = false
  return messages.filter((m) => {
    if (m.type === "user") inRequest = m.metadata?.prefixEditor === REQUEST.prefixEditor
    return !inRequest && m.metadata?.prefixEditor !== NOTE.prefixEditor
  })
}

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

function partSections(p: Part, ref: [number, number]): PartSpec[] {
  if (p.type === "text" || p.type === "reasoning") return [{ ref, kind: p.type, body: p.text }]
  if (p.type !== "tool") return [{ ref, kind: (p as { type: string }).type, body: "" }]
  const out = output(p)
  return [
    { ref, kind: "tool-input", label: p.name, body: JSON.stringify(p.state.input, null, 2) },
    ...(out === undefined ? [] : [{ ref, kind: "tool-output", label: p.name, body: out }]),
  ]
}

type Compaction = Extract<Stored, { type: "compaction"; status: "completed" }>
const keepIDOf = (m: Compaction) => (typeof m.metadata?.keepID === "string" ? m.metadata.keepID : undefined)

/**
 * How each message reaches the model. OpenCode sends history from the latest completed compaction on; of the
 * messages before it, the ones from its `keepID` on are rebuilt into the summary as plain text.
 */
export function reach(messages: Stored[]): ("sent" | "summary" | "unsent")[] {
  const at = messages.findLastIndex((m) => m.type === "compaction" && m.status === "completed")
  // shortcut: a native compaction made by another model is skipped by OpenCode; treated as active here.
  const c = messages[at] as Compaction | undefined
  const keepID = c && !c.native ? keepIDOf(c) : undefined
  const kept = keepID ? messages.findIndex((m) => m.id === keepID) : -1
  // The kept text leaves out earlier compactions and instruction updates.
  const inText = (m: Stored) => m.type !== "compaction" && m.type !== "system"
  return messages.map((m, i) => (i >= at ? "sent" : kept >= 0 && i >= kept && inText(m) ? "summary" : "unsent"))
}

const REACH_LABEL = { sent: undefined, summary: "(sent as summary text)", unsent: "(not sent)" } as const

/** The session as editable structure: the system prompt followed by every stored message. */
export function current(messages: Stored[], system: SystemSpec): Prefix {
  const reached = reach(messages)
  return {
    system,
    messages: messages.map((m, i) => ({
      ref: i,
      type: m.type,
      label: [label(m), REACH_LABEL[reached[i]!]].filter(Boolean).join(" ") || undefined,
      body: textOf(m) ?? "",
      parts: m.type === "assistant" ? m.content.flatMap((p, j) => partSections(p, [i, j])) : [],
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
  const copy = (m: MessageSpec): Stored[] => {
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
  }
  const ids = new Map<string, string>() // original id -> id in the copy
  const out = specs.flatMap((m) => {
    const copied = copy(m)
    if (m.ref !== undefined && copied[0]) ids.set(orig[m.ref]!.id, copied[0].id)
    return copied
  })
  return out.map((m) => (m.type === "compaction" && m.status === "completed" ? withKeepID(m, orig, ids) : m))
}

/**
 * A summary compaction names the first message it kept by id, so the copy must point at that message's new id,
 * or the next original message that survived the edit. Otherwise OpenCode silently drops the kept text.
 */
function withKeepID(c: Compaction, orig: Stored[], ids: Map<string, string>): Stored {
  const keepID = keepIDOf(c)
  if (!keepID) return c
  const from = orig.findIndex((m) => m.id === keepID)
  const to = orig.findIndex((m) => ids.get(m.id) === c.id)
  const next = from < 0 ? undefined : orig.slice(from, to < 0 ? undefined : to).find((m) => ids.has(m.id))
  const { keepID: _, ...metadata } = c.metadata ?? {}
  return { ...c, metadata: next ? { ...metadata, keepID: ids.get(next.id)! } : metadata }
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
    ...system.map((s) => chunk(`=== system-prompt${tag(s.ref, s.label)} ===`, s.text)),
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

// --- Edits from the model (/edit-prefix <instruction>) ---

export type Edit = {
  op: "delete" | "replace" | "insert"
  ref?: string
  after?: string
  text?: string
  section?: "tool-input" | "tool-output"
}

/** The edits in a model's reply: a JSON array, in a code fence or bare. */
export function extractEdits(reply: string): Edit[] {
  if (!reply.trim()) throw new Error("the reply was empty; reply with text, not a tool call")
  const fenced = /```(?:json)?[^\n]*\n([\s\S]*?)```/.exec(reply)?.[1]
  const body = fenced ?? reply.slice(reply.indexOf("["), reply.lastIndexOf("]") + 1)
  if (!body.trim()) throw new Error("the reply has no JSON array of edits")
  let edits: unknown
  try {
    edits = JSON.parse(body)
  } catch (e) {
    throw new Error(`the reply is not valid JSON (${(e as Error).message})`)
  }
  if (!Array.isArray(edits) || !edits.every((e) => typeof e === "object" && e !== null && typeof e.op === "string"))
    throw new Error("expected a JSON array of edit objects, each with an op")
  return edits as Edit[]
}

const REF = /^(?:(system-prompt) )?#(\d+)(?:\.(\d+))?(?: .*)?$/ // a trailing label is ignored
const EDITABLE = ["text", "reasoning", "tool-input", "tool-output"]

/** One line per section with its ref and the start of its text, so the model can name sections without re-reading them. */
export function outline({ system, messages }: Prefix, width = 80): string {
  const line = (header: string, body: string) => {
    const first = body.trim().replace(/\s+/g, " ")
    return first ? `${header}: ${first.length > width ? `${first.slice(0, width - 1)}…` : first}` : header
  }
  return [
    ...system.map((s) => line(`system-prompt${tag(s.ref, s.label)}`, s.text)),
    ...messages.flatMap((m) => [
      line(`${m.type}${tag(m.ref, m.label)}`, m.body),
      ...m.parts.map((p) => line(`  ${p.kind}${tag(p.ref, p.label)}`, p.body)),
    ]),
  ].join("\n")
}

/** Applies edits addressed by ref (`#N`, `#N.M`, `system-prompt #N`). Refs name the original sections, so order rarely matters. */
export function applyEdits(prefix: Prefix, edits: Edit[]): Prefix {
  const out = structuredClone(prefix)
  const locate = (ref: string) => {
    const m = REF.exec(ref.trim())
    if (!m || (m[1] && m[3] !== undefined)) throw new Error(`Invalid ref "${ref}": use #N, #N.M or system-prompt #N`)
    const n = Number(m[2])
    const i = m[1] ? out.system.findIndex((s) => s.ref === n) : out.messages.findIndex((x) => x.ref === n)
    if (i < 0) throw new Error(`Unknown ref ${ref}`)
    if (m[1]) return { at: "system" as const, i }
    if (m[3] === undefined) return { at: "message" as const, i }
    const j = Number(m[3])
    const parts = out.messages[i]!.parts
    const sections = parts.filter((p) => p.ref?.[1] === j)
    if (!sections.length) throw new Error(`Unknown ref ${ref}`)
    return { at: "part" as const, i, j, parts, sections }
  }
  const text = (e: Edit) => {
    if (typeof e.text !== "string") throw new Error(`${e.op} needs text`)
    return e.text
  }

  for (const e of edits) {
    if (e.op === "insert") {
      const body = text(e)
      if (e.after === undefined) {
        out.messages.push({ type: "user", body, parts: [] })
        continue
      }
      const t = locate(e.after)
      if (t.at === "system") out.system.splice(t.i + 1, 0, { text: body })
      else if (t.at === "message") out.messages.splice(t.i + 1, 0, { type: "user", body, parts: [] })
      else t.parts.splice(t.parts.lastIndexOf(t.sections.at(-1)!) + 1, 0, { kind: "text", body })
      continue
    }
    if (e.op !== "delete" && e.op !== "replace") throw new Error(`Unknown op "${e.op}"`)
    if (e.ref === undefined) throw new Error(`${e.op} needs a ref`)
    const t = locate(e.ref)
    if (e.op === "delete") {
      if (t.at === "system") out.system.splice(t.i, 1)
      else if (t.at === "message") out.messages.splice(t.i, 1)
      else out.messages[t.i]!.parts = t.parts.filter((p) => !t.sections.includes(p))
      continue
    }
    const body = text(e)
    if (t.at === "system") out.system[t.i]!.text = body
    else if (t.at === "message") {
      if (out.messages[t.i]!.type === "assistant") throw new Error(`Replace the parts of assistant ${e.ref} (#N.M) instead`)
      out.messages[t.i]!.body = body
    } else {
      const tool = t.sections[0]!.kind.startsWith("tool-")
      const section = tool ? t.sections.find((p) => p.kind === (e.section ?? "tool-output")) : t.sections[0]
      if (!section) throw new Error(`${e.ref} has no ${e.section ?? "tool-output"}`)
      if (!EDITABLE.includes(section.kind)) throw new Error(`${section.kind} ${e.ref} has no editable text`)
      section.body = body
    }
  }
  return out
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
