/**
 * The chat view in the side bar, and the wiring between it and the agent.
 *
 * The webview is a renderer and nothing more: it holds no opinion about when a
 * turn ends or whether a tool may run. It forwards what the user did and draws
 * what the agent said. That keeps the protocol interpretation in one place —
 * see the note at the top of agent.ts for why that matters.
 */

import * as vscode from "vscode";

import { Agent, type AgentCommand, type AgentEvent } from "./agent";

/** Messages the webview sends up. */
type ViewMessage =
  | { type: "mounted" }
  | { type: "prompt"; text: string }
  | { type: "approval"; id: number; allow: boolean; always: boolean }
  | { type: "model"; text: string }
  | { type: "login" }
  | { type: "apiKey"; key: string }
  | { type: "signOut" }
  | { type: "pickModel" }
  | { type: "refreshUsage" }
  | { type: "reset" }
  | { type: "restart" };

/** Where the pasted key lives. Never a setting: those are plain text on disk
 *  and ride along with Settings Sync. */
const API_KEY_SECRET = "measycode.apiKey";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "measycode.chat";

  private view?: vscode.WebviewView;
  /** Replayed when the view is rebuilt, so a reopened panel is not blank. */
  private lastReady?: Extract<AgentEvent, { kind: "ready" }>;
  /** Same, for the allowance — it is only reported when asked for. */
  private lastUsage?: Extract<AgentEvent, { kind: "usage_info" }>;
  /**
   * undefined until we find out. A binary older than the `usage` command
   * ignores it silently, so "no answer" is the only signal that it is not
   * supported — hence the timer rather than an error path.
   */
  private usageSupported?: boolean;
  private usageProbe?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agent: Agent,
    private readonly status: vscode.StatusBarItem,
    private readonly secrets: vscode.SecretStorage,
  ) {
    this.agent.onEvent((event) => this.onAgentEvent(event));
    this.agent.onExit((reason) => {
      this.post({ type: "exit", reason });
      this.refreshStatus();
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };

    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((message: ViewMessage) =>
      this.onViewMessage(message),
    );
  }

  /** Puts text in the composer and focuses the view — used by the editor command. */
  async insertPrompt(text: string): Promise<void> {
    await vscode.commands.executeCommand("measycode.chat.focus");
    this.post({ type: "compose", text });
  }

  send(command: AgentCommand): void {
    this.agent.send(command);
  }

  /**
   * Forgets both credentials and restarts.
   *
   * Two separate ones can be in play. `logout` clears the CLI's own file, but
   * a key we injected lives in this extension's secret storage and would
   * silently sign the user straight back in on the next spawn.
   */
  async signOut(): Promise<void> {
    this.agent.send({ kind: "logout" });
    await this.secrets.delete(API_KEY_SECRET);
    await this.restart();
  }

  /**
   * Stores a pasted key and restarts.
   *
   * A restart is not optional: the key reaches the agent through its process
   * environment, so it cannot be applied to one that is already running.
   */
  async useApiKey(key: string): Promise<void> {
    await this.secrets.store(API_KEY_SECRET, key.trim());
    await this.restart();
  }

  /** Clears the conversation on both sides — the agent's history and the view. */
  reset(): void {
    this.agent.send({ kind: "reset" });
    this.post({ type: "clear" });
  }

  /** Stops the agent and starts a fresh one in the current workspace. */
  async restart(): Promise<void> {
    await this.agent.stop();
    this.lastReady = undefined;
    this.post({ type: "clear" });
    await this.ensureRunning();
  }

  private async onViewMessage(message: ViewMessage): Promise<void> {
    switch (message.type) {
      case "mounted":
        // The view can mount before or after the agent is up; replay whatever
        // we already know rather than leaving it to guess.
        if (this.lastReady) {
          this.post({ type: "agent", event: this.lastReady });
        }
        if (this.lastUsage) {
          this.post({ type: "agent", event: this.lastUsage });
        }
        await this.ensureRunning();
        break;

      case "pickModel":
        // Handed to the editor's own quick pick rather than drawn in the
        // webview: it comes with filtering, keyboard navigation and the
        // platform's screen-reader behaviour already correct.
        await vscode.commands.executeCommand("measycode.pickModel");
        break;

      case "refreshUsage":
        this.requestUsage();
        break;

      case "prompt":
        if (!(await this.ensureRunning())) {
          return;
        }
        this.agent.send({ kind: "prompt", text: message.text });
        break;

      case "approval":
        this.agent.send({
          kind: "approval",
          id: message.id,
          allow: message.allow,
          always: message.always,
        });
        break;

      case "model":
        this.agent.send({ kind: "model", text: message.text });
        break;

      case "login":
        if (!(await this.ensureRunning())) {
          return;
        }
        this.agent.send({ kind: "login" });
        break;

      case "apiKey":
        await this.useApiKey(message.key);
        break;

      case "signOut":
        await this.signOut();
        break;

      case "reset":
        this.reset();
        break;

      case "restart":
        await this.restart();
        break;
    }
  }

  /**
   * Starts the agent if it is not up. Returns false when it cannot be started,
   * having already told the user why.
   */
  private async ensureRunning(): Promise<boolean> {
    if (this.agent.running) {
      return true;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      // `-dir` needs a real directory, and an agent pointed at nothing would
      // fail on its first file read rather than here, where it can be explained.
      this.post({
        type: "blocked",
        text: "Open a folder to use MeasyCode — the agent works inside a workspace.",
      });
      return false;
    }

    try {
      const apiKey = await this.secrets.get(API_KEY_SECRET);
      await this.agent.start(folder.uri.fsPath, apiKey);
      this.refreshStatus();
      return true;
    } catch (err) {
      this.post({
        type: "agent",
        event: { kind: "error", text: err instanceof Error ? err.message : String(err) },
      });
      return false;
    }
  }

  private onAgentEvent(event: AgentEvent): void {
    if (event.kind === "ready") {
      this.lastReady = event;
      this.refreshStatus();
      this.applyReasoningPreference();
      this.warnIfCatalogueMissing(event);
      this.requestUsage();
    }
    if (event.kind === "auth_required") {
      this.lastReady = undefined;
      this.lastUsage = undefined;
      this.refreshStatus();
    }
    if (event.kind === "usage_info") {
      this.lastUsage = event;
      this.usageSupported = true;
      clearTimeout(this.usageProbe);
    }
    // The allowance moves only when tokens are spent, so asking after a turn
    // is both sufficient and the moment the number is most worth seeing.
    if (event.kind === "turn_end") {
      this.requestUsage();
    }
    this.post({ type: "agent", event });
  }

  /**
   * Asks for the allowance, and finds out once whether asking works at all.
   *
   * The first request starts a timer. If nothing comes back the installed
   * binary predates the command, and the view is told so — otherwise the
   * missing number reads as a bug in the extension rather than as an old CLI.
   * Checked once per session; after that a silent answer is just a slow one.
   */
  private requestUsage(): void {
    if (this.usageSupported === false || !this.agent.running) {
      return;
    }

    this.agent.send({ kind: "usage" });

    if (this.usageSupported === undefined && this.usageProbe === undefined) {
      this.usageProbe = setTimeout(() => {
        if (this.usageSupported === undefined) {
          this.usageSupported = false;
          this.post({ type: "usageUnsupported" });
        }
      }, 20_000);
    }
  }

  /**
   * A `ready` with no model list is the shape a bad API key arrives in.
   *
   * The agent builds the catalogue by calling the API, and reports `ready`
   * either way — so an unusable credential looks exactly like a successful
   * sign-in until the first prompt fails. Worth saying out loud.
   *
   * Phrased as a possibility rather than a verdict: the same empty list comes
   * back when the catalogue call times out, and telling someone their key is
   * wrong when their Wi-Fi dropped sends them to revoke a working key.
   */
  private warnIfCatalogueMissing(event: Extract<AgentEvent, { kind: "ready" }>): void {
    if ((event.models?.length ?? 0) > 0) {
      return;
    }
    this.post({
      type: "agent",
      event: {
        kind: "notice",
        text:
          "Signed in, but the model list came back empty. That usually means the API key was rejected — or that the catalogue request timed out.",
      },
    });
  }

  /**
   * Applies `measycode.showReasoning` once a session is up.
   *
   * Only sent when it differs from the agent's own default, which is on:
   * sending it unconditionally would put a "thinking on" notice in the
   * transcript every single time a session starts.
   */
  private applyReasoningPreference(): void {
    const show = vscode.workspace
      .getConfiguration("measycode")
      .get<boolean>("showReasoning", true);

    if (!show) {
      this.agent.send({ kind: "think", allow: false });
    }
  }

  private refreshStatus(): void {
    if (!this.agent.running) {
      this.status.text = "$(circle-slash) MeasyCode";
      this.status.tooltip = "MeasyCode is not running";
      return;
    }
    if (!this.lastReady) {
      this.status.text = "$(key) MeasyCode";
      this.status.tooltip = "Sign in to MeasyCode";
      return;
    }
    const model = this.lastReady.model.replace(/^measyai\//, "");
    this.status.text = `$(sparkle) ${model}`;
    this.status.tooltip = `MeasyCode — ${this.lastReady.account ?? "signed in"}`;
  }

  /** Models the agent reported, for the picker command. */
  get models(): string[] {
    return this.lastReady?.models ?? [];
  }

  get currentModel(): string | undefined {
    return this.lastReady?.model;
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const asset = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...parts));

    const script = asset("media", "chat.js");
    const style = asset("media", "chat.css");
    const nonce = makeNonce();

    // default-src 'none' and a per-load nonce: the transcript renders model
    // output, which is untrusted text arriving through a trusted channel.
    // Nothing here may reach the network or run an inline handler.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
  <title>MeasyCode</title>
</head>
<body>
  <div id="banner" class="banner" hidden></div>

  <section id="login" class="login" hidden aria-label="Sign in">
    <h1 class="login-title">Sign in to MeasyCode</h1>

    <button id="login-browser" type="button" class="login-primary">
      Continue with MeasyAI
    </button>
    <p class="login-hint">
      Opens your browser and signs in with your account, so no key is created
      and nothing lands on your clipboard.
    </p>

    <div id="login-device" class="login-device" hidden></div>

    <div class="login-or"><span>or</span></div>

    <label class="login-label" for="login-key">API key</label>
    <input id="login-key" type="password" class="login-input"
           placeholder="msy_…" autocomplete="off" spellcheck="false">
    <p id="login-error" class="login-error" hidden></p>
    <button id="login-key-submit" type="button" class="login-secondary">
      Use this key
    </button>
    <p class="login-hint">
      MeasyCode does not create API keys for you. Make one at
      measyai.com/app/api-keys and paste it here. It is stored in your editor's
      secret storage, not in settings.
    </p>
  </section>

  <main id="transcript" class="transcript" aria-live="polite" aria-label="Conversation"></main>

  <div id="approval" class="approval" hidden></div>

  <form id="composer" class="composer">
    <textarea id="input" rows="1" placeholder="Ask MeasyCode…"
              aria-label="Message" autocomplete="off"></textarea>
    <div class="composer-row">
      <button id="model-pick" type="button" class="chip" title="Change model">
        <span id="model-name">…</span>
        <span class="caret" aria-hidden="true">▾</span>
      </button>
      <button id="usage" type="button" class="chip usage" hidden
              title="Rolling allowance — click to refresh">
        <span class="usage-bar" aria-hidden="true"><span id="usage-fill"></span></span>
        <span id="usage-text"></span>
      </button>
      <button id="send" type="submit" class="send">Send</button>
    </div>
  </form>

  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return text;
}
