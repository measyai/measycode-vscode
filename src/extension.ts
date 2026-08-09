import * as vscode from "vscode";

import { Agent } from "./agent";
import { ChatViewProvider } from "./chatView";
import { initLog, log, showLog } from "./log";

export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  log("MeasyCode activated");

  const agent = new Agent();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "measycode.focus";
  status.text = "$(circle-slash) MeasyCode";
  status.tooltip = "MeasyCode is not running";
  status.show();

  const provider = new ChatViewProvider(
    context.extensionUri,
    agent,
    status,
    context.secrets,
  );

  context.subscriptions.push(
    agent,
    status,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      // A chat is the case this option exists for. Rebuilding the view on
      // every tab switch would discard the transcript and, worse, the
      // half-streamed answer of a turn that is still running.
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand("measycode.focus", () =>
      vscode.commands.executeCommand("measycode.chat.focus"),
    ),

    vscode.commands.registerCommand("measycode.restart", async () => {
      await vscode.commands.executeCommand("measycode.chat.focus");
      await provider.restart();
    }),

    vscode.commands.registerCommand("measycode.stop", () => agent.stop()),

    vscode.commands.registerCommand("measycode.showLog", () => showLog()),

    vscode.commands.registerCommand("measycode.reset", () => provider.reset()),

    vscode.commands.registerCommand("measycode.signIn", async () => {
      await vscode.commands.executeCommand("measycode.chat.focus");
      provider.send({ kind: "login" });
    }),

    vscode.commands.registerCommand("measycode.signOut", () => provider.signOut()),

    vscode.commands.registerCommand("measycode.useApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "MeasyCode API key",
        prompt: "Paste a key from measyai.com/app/api-keys",
        placeHolder: "msy_…",
        password: true,
        ignoreFocusOut: true,
        // The same two rules the CLI applies, so a typo is caught before it
        // costs an agent restart.
        validateInput: (value) => {
          const key = value.trim();
          if (!key) {
            return null; // nothing typed yet is not an error
          }
          if (key.startsWith("msys_")) {
            return "That is a session token, not an API key.";
          }
          if (!key.startsWith("msy_")) {
            return "A MeasyAI API key starts with msy_.";
          }
          return null;
        },
      });

      if (key?.trim()) {
        await provider.useApiKey(key);
      }
    }),

    vscode.commands.registerCommand("measycode.pickModel", async () => {
      const models = provider.models;
      if (models.length === 0) {
        // The catalogue comes from the server on `ready`. Without it there is
        // nothing honest to show, and a hardcoded list would be a guess about
        // someone else's account.
        void vscode.window.showInformationMessage(
          "No model list yet — start MeasyCode and sign in first.",
        );
        return;
      }

      const current = provider.currentModel;
      const picked = await vscode.window.showQuickPick(
        models.map((id) => ({
          label: id.replace(/^measyai\//, ""),
          description: id === current ? "current" : undefined,
          id,
        })),
        { title: "MeasyCode model", placeHolder: current ?? "Select a model" },
      );

      if (picked) {
        provider.send({ kind: "model", text: picked.id });
      }
    }),

    vscode.commands.registerCommand("measycode.askAboutSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        return;
      }

      // A path relative to the workspace, because that is how the agent — which
      // was started with -dir at the workspace root — refers to files itself.
      const relative = vscode.workspace.asRelativePath(editor.document.uri);
      const start = editor.selection.start.line + 1;
      const end = editor.selection.end.line + 1;
      const where = start === end ? `${relative}:${start}` : `${relative}:${start}-${end}`;

      await provider.insertPrompt(`In ${where}:\n\n${editor.document.getText(editor.selection)}`);
    }),
  );
}

export function deactivate(): void {
  // The agent is disposed through context.subscriptions, which closes its
  // stdin and lets the Go process finish whatever it was persisting.
}
