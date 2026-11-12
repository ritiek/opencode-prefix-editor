# opencode-prefix-editor

An [OpenCode](https://opencode.ai) V2 plugin to edit what the model sees, the system prompt and the conversation
history, in your `$EDITOR`.

Run `/edit-prefix` in a session. Its system prompt and history open as plain text. Save and quit:

- History edits are saved as a new session, `<title> (edited)`, and the TUI switches to it. Its transcript shows
  exactly the history the model gets. The original session is left untouched.
- System prompt edits apply to every later request in the session (and carry over to sessions forked from it).

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

| Command | |
| --- | --- |
| `/edit-prefix` | Open the session's system prompt and history in `$VISUAL` / `$EDITOR` (default `vi`). |
| `/reset-prefix` | Drop this session's system prompt edit. |

Both are also in the command palette (`ctrl+p`). Saving without changes, or quitting with a non-zero exit (`:cq`),
changes nothing. If the edited text does not parse, you can reopen it with your changes intact.

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
its `generate` hook before anything reaches the model. The two parts talk over a plugin RPC.

## Development

```sh
bun install
bun test
bun run typecheck
nix flake check
```

## License

MIT
