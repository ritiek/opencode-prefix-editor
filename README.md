# opencode-prefix-editor

An [OpenCode](https://opencode.ai) V2 plugin to edit what the model sees, the system prompt and the conversation
history, in your `$EDITOR`.

Run `/edit-prefix` in a session. Its system prompt and history open as plain text. Save and quit, and the edit is
saved as a new session, `<title> (edited)`, which the TUI switches to. Its transcript shows exactly the history the
model gets, and its edited system prompt applies to every request it makes. What the original session sends the model
is left untouched, so switching back to it is the undo. The original only gains a line at the bottom of its transcript
saying where the edit went:

```text
◈ /edit-prefix drop the dead-end debugging → saved as "Fix the login bug (edited)"
```

The plugin keeps that line out of every model request, compaction and later copy.

Or let the model do the editing: `/edit-prefix drop the dead-end debugging` asks it for the edits, which then open in
your editor for review before they are saved the same way.

## Install

The plugin is a directory of TypeScript sources that OpenCode loads as-is. With Nix, take it from this flake:

```nix
# flake.nix
inputs.opencode-prefix-editor = {
  url = "github:ritiek/opencode-prefix-editor";
  inputs.nixpkgs.follows = "nixpkgs";
};

# home-manager
programs.opencode.settings.plugins = [
  "${inputs.opencode-prefix-editor.packages.${pkgs.stdenv.hostPlatform.system}.default}"
];
```

Without Nix, clone the repository and list its path under `plugins` in `opencode.json(c)`:

```jsonc
{
  "plugins": ["/path/to/opencode-prefix-editor"],
}
```

## Usage

`/edit-prefix` (also in the command palette, `ctrl+p`) opens the session's system prompt and history in `$VISUAL` /
`$EDITOR` (default `vi`). Saving without changes, or quitting with a non-zero exit (`:cq`),
changes nothing. If the edited text does not parse, you can reopen it with your changes intact.

`/edit-prefix <instruction>` asks the model for the edits through a one-off request (OpenCode's `session.generate`). The
model sees the session's context as usual plus your instruction and a one-line-per-section outline, and replies with a
JSON list of edits addressed by ref (`#N`, `#N.M`, `system-prompt #N`):

- `{"op": "delete", "ref"}` removes a section; deleting a tool part removes the call and its output.
- `{"op": "replace", "ref", "text", "section"?}` replaces a section's text; on a tool part, `section` picks `tool-input`
  or `tool-output` (the default).
- `{"op": "insert", "after"?, "text"}` adds a user message after a message (at the end when `after` is omitted), a text
  part after a part, or a system prompt section (system prompt insertions always go at the end).

The result opens in your editor as above, so you can adjust or discard it. If the reply doesn't parse or names unknown
sections, the model is asked again with the error, up to twice. The request is not added to the session, so its cost
does not show up in any session's cost. Wait for a running turn to finish first; the command refuses otherwise.
`/edit-prefix` requests that v0.2 sent into sessions, and the turns they started, are left out of copies and outlines.

## Format

```text
=== system-prompt #0 agent build ===
You are an AI agent running in OpenCode...

=== system-prompt #1 core/date ===
Today's date: Wed Nov 25 2026

=== user #0 ===
Fix the failing test.

=== assistant #1 ===
Running the tests.

--- tool-input #1.1 shell ---
{
  "command": "bun test"
}

--- tool-output #1.1 shell ---
1 fail ...

=== idle #2 ===
=== user ===
A message you added.
```

- `=== system-prompt #N <source> ===` is one source of the system prompt: the agent's own prompt (`agent <name>`), one
  instruction source (`core/date`, `core/environment`, ...), or a part another plugin adds (`plugin`).
- `=== <type> #N ===` starts a message: `user`, `synthetic` (reminders), `system`, `skill` and `compaction` hold
  editable text; `assistant` holds parts; markers such as `idle`, `shell` or `model-switched` can only be kept or
  deleted.
- `--- <kind> #N.M ---` starts a part of an assistant message: `text` and `reasoning` are plain text, `tool-input` is
  JSON, `tool-output` is plain text (JSON when the tool returned more than one item). Text right below an assistant
  header is its first text part. A trailing word in a header (tool name, model, ...) is only a label.
- `#N` refers to the original message or part, which supplies every field the text does not show.
- `(not sent)` marks messages before the latest compaction, which no longer reach the model; editing them only changes
  the transcript. `(sent as summary text)` marks the ones the compaction kept, which reach the model as plain text
  inside its summary.
- Delete a section, or clear its text, to remove it. A tool call goes once both its sections are gone. Add
  `=== user ===` or `--- text ---` without a number to insert new text.
- A line inside a message that would read as a header is shown with an extra leading `\`, which is removed again on
  save.

## Behavior

- Parts you did not change are copied verbatim. Changed assistant parts lose their provider replay data (`native`,
  such as reasoning signatures), so the model sees the edit; some providers then drop edited reasoning.
- The system prompt is not stored in the session, so a copy's edits are applied when each request is built. Only the
  sources you changed are stored; the rest stay live, so the date or a newly selected agent's prompt still come
  through. An edit to an agent's prompt applies only while that agent runs. A plugin part's edit applies only while
  the plugin still generates the same text. Compaction summaries are made without the edits.
- OpenCode's Claude Code harness provider builds its own prompt (its agent role comes from config, and it reads the
  instruction sources in a hook of its own), so system prompt edits may not reach it.
- A compaction refers to the first message it kept; copies point it at that message's new id, or at the next kept
  message that survived your edit.
- Editing a cached prefix invalidates the provider's prompt cache from the first changed byte.
- Sessions are copied through OpenCode's experimental export/import API.
- The line left in the original is a synthetic message posted without waking the model. Until the session's next
  turn it waits in the session's inbox; it is then stored, and the plugin filters it out of what the model gets by id.
  Without the plugin loaded, that later turn would send the line's text to the model.
- While you edit, the session is in a temporary file only you can read, removed when the editor closes.

## How it works

The TUI part exports the session, renders it, runs the editor (suspending the terminal UI), and imports the edited
messages as a new session with fresh ids. For `/edit-prefix <instruction>` it first gets the edits from a
`session.generate` request, which reads the session's context without adding to it. The server part stores each copy's
system prompt edits and applies them to their sources from its `context` and `generate` hooks. To show the current
system prompt it issues a transient `session.generate` request and aborts it from an earlier `generate` hook before
anything reaches the model. After a save it posts the line in the original and records its id, which its hooks drop from every request. The two
parts talk over a plugin RPC.

## Development

```sh
bun install
bun test
bun run typecheck
nix flake check
```

## License

MIT
