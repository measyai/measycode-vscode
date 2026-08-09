# Changelog

## 0.1.0

First release.

- Chat view in the side bar, driving `measy -jsonl` — the same agent loop the
  terminal runs, not a second implementation of it.
- Streaming answers, collapsible reasoning, and tool calls with their output.
  A tool that failed opens itself; one that succeeded stays out of the way.
- Approval prompts for writes, with focus on **Deny** rather than Allow.
- Sign in with your MeasyAI account through the browser device flow, or paste
  an API key. Keys are kept in the editor's secret storage, never in settings.
- Model picker fed by your account's catalogue.
- **Ask MeasyCode About Selection** from the editor context menu.

### Known limitations

- The transcript is plain text; Markdown and code blocks are not rendered.
- The agent runs against the first folder of a multi-root workspace.
- One session per window.
