# Changelog

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

- **Rendered Markdown** in answers: fenced code with a copy button, inline
  code, bold, italic, headings, lists, quotes and links. Built by creating
  elements rather than by assembling HTML, so model output cannot inject
  markup.

### Known limitations

- Markdown tables, images and footnotes are shown as text.
- The agent runs against the first folder of a multi-root workspace.
- One session per window.
