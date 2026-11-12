# opencode-prefix-editor

An [OpenCode](https://opencode.ai) V2 plugin to edit what the model sees, the system prompt and the conversation
history, in your `$EDITOR`.

Run `/edit-prefix` in a session. The current system prompt and history open as plain text; save and quit, and every
following request in that session sends your version instead. New turns are appended after it.

## Install

```sh
opencode plugin add opencode-prefix-editor
```

Or list it under `plugins` in `opencode.json(c)`, as a package name or a local path:

```jsonc
{
  "plugins": ["opencode-prefix-editor"],
}
```

## Usage

| Command | |
| --- | --- |
| `/edit-prefix` | Open the session's system prompt and history in `$VISUAL` / `$EDITOR` (default `vi`). |
| `/reset-prefix` | Drop the edit and send the original system prompt and history again. |

Both are also in the command palette (`ctrl+p`). Saving without changes, or quitting with a non-zero exit (`:cq`),
changes nothing. If the edited text does not parse, you can reopen it with your changes intact.

## Format

```text
=== system prompt #0 ===
You are an AI agent running in OpenCode...

=== user #0 ===
Fix the failing test.

=== assistant #1 ===
Running the tests.

--- tool-call #1.1 ---
{
  "command": "bun test"
}

=== tool #2 ===
--- tool-result #2.0 ---
1 fail ...

=== user ===
A message you added.
```

- `=== <role> #N ===` starts a message (`system prompt`, `system`, `user`, `assistant` or `tool`). Text right below it
  is the message's first text part.
- `--- <type> #N.M ---` starts one part of a message. Text and reasoning are plain text; tool calls and tool results
  are JSON (text tool results are plain text). Other parts, such as images, show only their header: keep it or delete
  it.
- `#N` refers to the original message or part. Fields the text does not show (ids, cache hints, provider metadata)
  are carried over from it, and parts you did not change are sent exactly as before.
- Delete a section, or clear its text, to remove it. Add `=== user ===` or `--- text ---` without a number to insert
  new text.
- A line inside a part that would read as a header is shown with an extra leading `\`, which is removed again on
  save.

## Behavior

- Only what is sent to the model changes. The stored session, the transcript in the UI, and the history other clients
  see stay as they were.
- The edit sticks to the session: it replaces the history you saw, and later messages follow it.
- When the history is rewritten under it (compaction, revert), the edit no longer matches and is dropped
  automatically.
- Editing a cached prefix invalidates the provider's prompt cache from the first changed byte.
- Compaction summaries are made from the original history.

## How it works

The server part registers a `context` hook that swaps in the edited prefix before each agent-loop request, and stores
edits in plugin storage keyed by session. To show the current context, including the reply that just finished, it
issues a transient `session.generate` request and aborts it from its `generate` hook before anything reaches the model.
The TUI part suspends the terminal UI, runs the editor, and talks to the server part over a plugin RPC.

## Development

```sh
bun install
bun test
bun run typecheck
```

## License

MIT
