# MeasyCode for VS Code

> AI coding agent that lives in your editor.

The same agent as [`measy`](https://github.com/measyai/measycode) in the
terminal — this is a front end for it, not a second implementation.

## How it works

MeasyCode already speaks a line-oriented JSON protocol on stdio (`measy
-jsonl`), one object per line each way, precisely so a GUI can drive the same
agent loop the terminal uses. This extension spawns that process, forwards its
output into the chat view, and writes commands back to its stdin.

That is deliberately all it does. Which tools exist, when approval is needed,
how a turn ends — every one of those decisions stays in the Go process. If this
extension ever starts deciding them too, the two have begun to drift, and that
is the bug to fix rather than the feature to keep.

The contract is `jsonl.go` in the CLI repo.

## Requirements

MeasyCode must be installed and on your `PATH`:

```bash
curl -fsSL https://github.com/measyai/measycode/releases/latest/download/install.sh | bash
```

```powershell
irm https://github.com/measyai/measycode/releases/latest/download/install.ps1 | iex
```

If it lives somewhere the `PATH` does not reach, set `measycode.binaryPath`.

## Signing in

Two ways, the same two the terminal offers:

**Continue with MeasyAI** runs the browser device flow. What comes back is a
session — the same credential the website holds — and it is stored by the CLI,
so signing in here signs you in there too. This is the path for a subscription,
and nothing ever reaches your clipboard.

**An API key** you made yourself at
[measyai.com/app/api-keys](https://measyai.com/app/api-keys). MeasyCode never
mints keys on your behalf, deliberately: a key you did not knowingly create is
one you will not recognise later and will not dare revoke.

A pasted key is kept in your editor's **secret storage**, never in settings —
settings are plain text on disk and ride along with Settings Sync. It reaches
the agent as `MEASYAI_API_KEY` in its environment, which is the CLI's own
documented override and takes precedence over its stored credential file. That
also means applying a key requires restarting the agent, which the extension
does for you.

Because two credentials can be in play at once, **Sign Out** clears both: it
sends `logout` to the CLI *and* deletes the stored key. Clearing only one would
sign you straight back in on the next start.

If sign-in appears to succeed but the model list comes back empty, the key was
most likely rejected — the agent reports itself ready either way. The view says
so rather than letting you discover it on your first prompt.

## Using it

Open the MeasyCode view in the activity bar, or press `Ctrl+Shift+M`
(`Cmd+Shift+M` on macOS). The agent starts in your first workspace folder — it
needs a real directory, so an empty window will ask you to open a folder first.

| Command | |
|---|---|
| `MeasyCode: Focus Chat` | Open the view |
| `MeasyCode: Select Model` | Switch models — also the chip in the composer |
| `MeasyCode: Clear Conversation` | Drop the context, keep the session |
| `MeasyCode: Restart Agent` | Stop the process and start a fresh one |
| `MeasyCode: Sign In` | Browser device flow |
| `MeasyCode: Sign In with an API Key` | Paste a key instead |
| `MeasyCode: Sign Out` | Forget both credentials |

Select code in an editor and choose **Ask MeasyCode About Selection** from the
context menu to drop it into the composer with its file and line range.

Two chips sit above the Send button. The first is the current model — click it
for the picker, filled from your account's own catalogue rather than a list
baked into the extension. The second is what is left of your rolling token
allowance; it refreshes after each turn, turns amber past three quarters and
red past nine tenths, and reads simply "unlimited" on a plan without a cap. It
appears only when the installed MeasyCode is new enough to report usage.

Writes ask for approval before they happen. The dialog opens with **Deny**
focused, not Allow: the agent is asking to change your files, and a stray Enter
should not be what grants it. **Always allow** switches the session to Developer
mode — the same thing `/approval developer` does in the terminal.

### Settings

| | |
|---|---|
| `measycode.binaryPath` | Path to `measy`. Empty means "find it on the `PATH`". |
| `measycode.showReasoning` | Show the model's chain of thought. On by default. |

The model and approval mode are **not** settings here. They come from the
agent's own configuration, so this extension cannot quietly disagree with your
terminal about either one.

## Known limitations

- **The transcript is plain text.** Markdown and code blocks arrive as written
  rather than rendered — readable, but not pretty. Rendering model output as
  HTML is a decision that deserves its own care around sanitisation, so it is
  not in this version.
- **One workspace folder.** The agent is started against the first folder of a
  multi-root workspace.
- **One session per window.** The protocol is a single conversation on a single
  pair of pipes.

## Development

```bash
npm install
npm run compile      # bundle to dist/
npm run watch        # rebuild on change
npm run typecheck
npm test             # see below
```

Press `F5` in VS Code to launch an Extension Development Host.

`npm test` runs the real `src/agent.ts` outside the extension host, with the
`vscode` module aliased to a small stub. It covers the two things that actually
break:

1. **Line assembly**, fed with deliberately hostile chunks. A pipe hands over
   whatever the OS had ready, so one `data` event is not one message — treating
   it as one works fine until a long tool body arrives.
2. **The process path** — spawn, handshake, polite stop — against the real
   `measy` binary, which must be installed for that half to be meaningful.

Both halves are needed. Break the buffering deliberately and the first half
fails loudly while the second stays green, because a handshake is small enough
to arrive in a single chunk.

## License

[MIT](LICENSE)
