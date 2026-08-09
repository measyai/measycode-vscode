/**
 * One output channel for the extension.
 *
 * A wrapper around a child process has exactly one confusing failure mode:
 * nothing happens. The process is there or it is not, it answered or it did
 * not, and from the outside both look like a chat that will not start. Every
 * step that can fail silently writes a line here so the answer is one
 * "MeasyCode" entry in the Output panel away.
 */

import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("MeasyCode");
  context.subscriptions.push(channel);
}

export function log(message: string): void {
  const stamp = new Date().toISOString().slice(11, 23);
  channel?.appendLine(`${stamp}  ${message}`);
}

export function showLog(): void {
  channel?.show(true);
}
