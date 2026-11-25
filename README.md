# opencode-prefix-editor

An [OpenCode](https://opencode.ai) V2 plugin to edit what the model sees, the system prompt and the conversation
history, in your `$EDITOR`.

Run `/edit-prefix` in a session. Its system prompt and history open as plain text. Save and quit, and the edit is
saved as a new session, `<title> (edited)`, which the TUI switches to. Its transcript shows exactly the history the
model gets, and its edited system prompt applies to every request it makes. The original session is left untouched,
so switching back to it is the undo.

Or let the model do the editing: `/edit-prefix drop the dead-end debugging` has it call `edit_prefix` with the edits,
which then open in your editor for review before they are saved the same way.

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

`/edit-prefix <instruction>` sends the model your instruction and a one-line-per-section outline of the session. The
model calls the `edit_prefix` tool once with a list of edits addressed by ref (`#N`, `#N.M`, `system-prompt #N`):

- `{op: "delete", ref}` removes a section; deleting a tool part removes the call and its output.
- `{op: "replace", ref, text, section?}` replaces a section's text; on a tool part, `section` picks `tool-input` or
  `tool-output` (the default).
- `{op: "insert", after?, text}` adds a user message after a message (at the end when `after` is omitted), a text part
  after a part, or a system prompt section after a system prompt section.

The result opens in your editor as above, so you can adjust or discard it. The copy is made from the session as it
was when you ran the command, so neither the request nor the tool call ends up in it. If the edits name unknown
sections, the tool tells the model what failed so it can try again. The tool only works for a TUI that ran
`/edit-prefix <instruction>` for that session; any other call returns after a few seconds without changing anything.

## Format

```text
=== system-prompt #0 ===
You are an AI agent running in OpenCode...

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

- `=== <type> #N ===` starts a message: `user`, `synthetic` (reminders), `system`, `skill` and `compaction` hold
  editable text; `assistant` holds parts; markers such as `idle`, `shell` or `model-switched` can only be kept or
  deleted.
- `--- <kind> #N.M ---` starts a part of an assistant message: `text` and `reasoning` are plain text, `tool-input` is
  JSON, `tool-output` is plain text (JSON when the tool returned more than one item). Text right below an assistant
  header is its first text part. A trailing word in a header (tool name, model, ...) is only a label.
- `#N` refers to the original message or part, which supplies every field the text does not show.
- Delete a section, or clear its text, to remove it. A tool call goes once both its sections are gone. Add
  `=== user ===` or `--- text ---` without a number to insert new text.
- A line inside a message that would read as a header is shown with an extra leading `\`, which is removed again on
  save.

## Behavior

- Parts you did not change are copied verbatim. Changed assistant parts lose their provider replay data (`native`,
  such as reasoning signatures), so the model sees the edit; some providers then drop edited reasoning.
- The system prompt is not stored in the session, so its edit is applied when each request is built. Compaction
  summaries are made without it.
- Editing a cached prefix invalidates the provider's prompt cache from the first changed byte.
- Sessions are copied through OpenCode's experimental export/import API.

## How it works

The TUI part exports the session, renders it, runs the editor (suspending the terminal UI), and imports the edited
messages as a new session with fresh ids. The server part stores system prompt edits per session and swaps them in from
a `context` hook. To show the current system prompt it issues a transient `session.generate` request and aborts it from
its `generate` hook before anything reaches the model. The two parts talk over a plugin RPC. The server part also
registers `edit_prefix`, which hands its edits to the TUI as a draft and returns whatever the review ended in.

## Development

```sh
bun install
bun test
bun run typecheck
nix flake check
```

## License

MIT
