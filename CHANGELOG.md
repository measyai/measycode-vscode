# Changelog

## 1.0.1

- **Rendered Markdown** in answers: fenced code with a copy button, inline
  code, bold, italic, headings, lists, quotes and links. Built by creating
  elements and setting `textContent`, never by assembling HTML, so model output
  cannot introduce markup and a `javascript:` link stays inert text.
- **Fixed: the chat panel stayed empty and sign-in did nothing.** Before
  starting the agent the extension probed for the binary by running
  `measy -whoami` and waiting — but that is an authenticated API call, twelve
  seconds here, and it was awaited before the real spawn. Now it spawns
  directly and catches `ENOENT`.
- **Fixed: links in the view went nowhere.** A webview refuses to navigate, so
  the device-flow link rendered as a link and did nothing. Links now open
  through `vscode.env.openExternal`, which is also the only thing that works
  under Remote and Codespaces.
- **Restricted Mode is explained** instead of silently disabling everything.
  Declared as `capabilities.untrustedWorkspaces: false`, since the agent edits
  files and runs commands.
- **New: `MeasyCode: Show Log`** — an output channel recording binary
  resolution, spawn, protocol events and exits.

## 1.0.0

First public release.

- **Chat view in the side bar**, driving `measy -jsonl` — the same agent loop
  the terminal runs, not a second implementation of it.
- **Streaming answers**, collapsible reasoning, and tool calls with their
  output. A tool that failed opens itself; one that succeeded stays out of the
  way.
- **Approval prompts** before writes, with focus on **Deny** rather than Allow.
  "Always allow" switches the session to Developer mode, exactly as
  `/approval developer` does in the terminal.
- **Sign in two ways** — your MeasyAI account through the browser device flow,
  or an API key you made yourself. Keys live in the editor's secret storage,
  never in settings.
- **Model picker** in the composer, fed by your account's own catalogue.
- **Token allowance** in the composer: how much of the rolling window is left,
  refreshed after every turn. Needs MeasyCode with the `usage` protocol
  command; older builds simply do not show it.
- **Ask MeasyCode About Selection** from the editor context menu.

### Known limitations

- Markdown tables, images and footnotes are shown as text.
- The agent runs against the first folder of a multi-root workspace.
- One session per window.
