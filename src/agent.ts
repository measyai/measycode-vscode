/**
 * The bridge between the editor and the MeasyCode agent.
 *
 * MeasyCode already speaks a line-oriented JSON protocol on stdio — one object
 * per line each way — precisely so a GUI can drive the same agent loop the
 * terminal uses instead of a second implementation drifting alongside it. This
 * module is the whole of the editor side of that: spawn the binary, pump its
 * stdout into events, write commands back to its stdin.
 *
 * Deliberately thin. Every decision about what the agent *does* — which tools
 * exist, when to ask for approval, how a turn ends — stays in the Go process.
 * If this file ever starts interpreting the protocol rather than forwarding
 * it, the two implementations have begun to drift and that is the bug to fix.
 *
 * The contract is `jsonl.go` in the measycode repo. When it grows a field,
 * this is where it lands, and nowhere else.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as vscode from "vscode";

import { log } from "./log";

/** Everything the agent can say. `kind` is the discriminator. */
export type AgentEvent =
  | {
      kind: "ready";
      model: string;
      models?: string[];
      dir: string;
      auto: boolean;
      account?: string;
      project?: string;
    }
  | { kind: "auth_required"; text?: string; dir?: string }
  | { kind: "auth_prompt"; url: string; code: string }
  | { kind: "user"; text: string }
  | { kind: "turn_start" }
  | { kind: "delta"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_start"; name: string; arg: string }
  | { kind: "tool_body"; text: string }
  | { kind: "tool_result"; summary: string; ok: boolean }
  | { kind: "approval_request"; id: number; name: string; text: string }
  | { kind: "turn_end" }
  | { kind: "turn_stats"; millis?: number; tokens?: number }
  | { kind: "notice"; text: string; auto?: boolean }
  | { kind: "error"; text: string }
  | { kind: "usage_info"; usage: UsageInfo }
  | { kind: "bye" };

/** The rolling allowance, as GET /v1/me reports it through the agent. */
export interface UsageInfo {
  limit: number;
  used: number;
  remaining: number;
  window_hours: number;
  unlimited: boolean;
  unit: string;
}

/** Everything the editor can say back. */
export type AgentCommand =
  | { kind: "prompt"; text: string }
  | { kind: "approval"; id: number; allow: boolean; always?: boolean }
  | { kind: "model"; text: string }
  | { kind: "auto"; allow: boolean }
  | { kind: "think"; allow: boolean }
  | { kind: "login" }
  | { kind: "logout" }
  | { kind: "reset" }
  // Answered with usage_info. Binaries older than this command ignore it in
  // silence — there is no reply and no error, so the caller must treat a
  // missing answer as "not supported" rather than waiting on it.
  | { kind: "usage" };

/**
 * The installed CLI is `measy`; `measycode` is the name it had before the
 * installer shortened it. Trying both means an older install keeps working.
 */
const BINARY_CANDIDATES = ["measy", "measycode"] as const;

export class Agent implements vscode.Disposable {
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private currentWorkspace?: string;
  /** Set while stop() is draining, so the exit is not reported as a crash. */
  private stopping = false;

  private readonly eventEmitter = new vscode.EventEmitter<AgentEvent>();
  readonly onEvent = this.eventEmitter.event;

  private readonly exitEmitter = new vscode.EventEmitter<string>();
  readonly onExit = this.exitEmitter.event;

  get running(): boolean {
    return this.child !== undefined;
  }

  get workspace(): string | undefined {
    return this.currentWorkspace;
  }

  /**
   * Starts the agent in `workspace`.
   *
   * `-jsonl` puts it in protocol mode; `-dir` is the folder it may touch.
   * Nothing else is passed: the model, the approval mode and the credential
   * all come from the agent's own configuration, so the editor cannot quietly
   * disagree with the terminal about any of them.
   */
  async start(workspace: string, apiKey?: string): Promise<void> {
    if (this.child) {
      throw new Error("An agent is already running.");
    }

    const child = await this.spawnFirstThatExists(workspace, apiKey);

    // setEncoding matters beyond convenience: without it a multi-byte UTF-8
    // character split across two chunks decodes as two replacement characters.
    // Node buffers the incomplete sequence for us once an encoding is set.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => this.consume(chunk));

    // stderr is not the protocol — it is panics, usage errors and anything
    // written before the encoder is installed. Dropping it would turn "the
    // agent died on startup" into a silent hang, which is the single most
    // confusing failure a wrapper like this can have.
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) {
          this.eventEmitter.fire({ kind: "error", text: line });
        }
      }
    });

    // Startup failures are handled by spawnFirstThatExists; anything arriving
    // here happened to an agent that was already running.
    child.on("error", (err: NodeJS.ErrnoException) => {
      const message = `The agent failed: ${err.message}`;
      log(message);
      this.eventEmitter.fire({ kind: "error", text: message });
      this.teardown(message);
    });

    child.on("exit", (code, signal) => {
      // Flush a trailing line that arrived without its newline, or the last
      // thing the agent said is lost exactly when it matters most.
      const tail = this.stdoutBuffer.trim();
      this.stdoutBuffer = "";
      if (tail) {
        this.handleLine(tail);
      }

      const reason = this.stopping
        ? "agent stopped"
        : signal
          ? `agent stopped (signal ${signal})`
          : `agent exited with code ${code ?? 0}`;
      this.teardown(reason);
    });

    this.child = child;
    this.currentWorkspace = workspace;
    this.stopping = false;
  }

  /**
   * Sends one command to the agent.
   *
   * Every field is filled in rather than omitted, matching what the desktop
   * app writes: the Go side ignores fields it does not know, so a newer editor
   * against an older binary degrades rather than breaks.
   */
  send(command: AgentCommand): void {
    const child = this.child;
    if (!child) {
      this.eventEmitter.fire({ kind: "error", text: "No agent is running." });
      return;
    }

    const line =
      JSON.stringify({ id: 0, text: "", allow: false, always: false, ...command }) + "\n";

    child.stdin.write(line, (err) => {
      if (err) {
        // A write failure means the child is gone. The pipe is the only thing
        // that says so promptly, since a process can exit long before anyone
        // waits on it.
        this.eventEmitter.fire({
          kind: "error",
          text: `The agent is no longer running: ${err.message}`,
        });
        this.teardown(`agent stopped: ${err.message}`);
      }
    });
  }

  /**
   * Stops the agent.
   *
   * Closing stdin first is the polite exit: the Go side reads until stdin
   * closes and then returns from its loop, finishing whatever it was
   * persisting. Only if that does not take effect is the process killed —
   * killing first would abandon a half-written file.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return; // stopping a stopped agent is not an error
    }

    this.stopping = true;
    child.stdin.end();

    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);

    if (!exited) {
      child.kill();
    }
  }

  dispose(): void {
    void this.stop();
    this.eventEmitter.dispose();
    this.exitEmitter.dispose();
  }

  /**
   * Spawns the agent, trying the alternative binary name if the first is not
   * installed.
   *
   * This used to probe first, by running `<name> -whoami` and seeing whether
   * it started. That was wrong twice over: `-whoami` is not an existence
   * check but an authenticated call to /v1/me, which measured at **twelve
   * seconds** here — and the probe was awaited before the real spawn, so the
   * agent could not start until it finished. The view sat empty the whole
   * time, which is indistinguishable from a broken extension.
   *
   * Spawning and catching ENOENT answers the same question immediately, with
   * no network and no second process.
   */
  private async spawnFirstThatExists(
    workspace: string,
    apiKey?: string,
  ): Promise<ChildProcessWithoutNullStreams> {
    const configured = configuredBinaryPath();
    const candidates = configured ? [configured] : [...BINARY_CANDIDATES];

    const options: Parameters<typeof spawn>[2] = {
      stdio: ["pipe", "pipe", "pipe"],
      // Without this a console window flashes up on every start on Windows,
      // because the child is a console application and Windows gives it one.
      windowsHide: true,
      // MEASYAI_API_KEY overrides the credential file, which is the CLI's own
      // documented rule for "an explicit export is a deliberate act". It is
      // the only route to key-based sign-in: the jsonl protocol's `login`
      // command runs the browser flow and nothing else.
      //
      // Only set when there is one. An empty value is still a value, and it
      // would shadow a perfectly good stored session with nothing.
      env: apiKey ? { ...process.env, MEASYAI_API_KEY: apiKey } : process.env,
    };

    let lastError: NodeJS.ErrnoException | undefined;

    for (const binary of candidates) {
      log(`starting "${binary}" -jsonl -dir ${workspace}${apiKey ? " (with API key)" : ""}`);
      try {
        return await spawnOrThrow(binary, ["-jsonl", "-dir", workspace], options);
      } catch (err) {
        lastError = err as NodeJS.ErrnoException;
        if (lastError.code !== "ENOENT") {
          break; // it exists but would not start; trying another name is noise
        }
        log(`"${binary}" is not installed`);
      }
    }

    const detail =
      lastError?.code === "ENOENT"
        ? `Could not find ${candidates.map((c) => `"${c}"`).join(" or ")}. ` +
          "Is MeasyCode installed and on your PATH? Set measycode.binaryPath if it lives elsewhere."
        : `Could not start MeasyCode: ${lastError?.message ?? "unknown error"}`;

    log(detail);
    throw new Error(detail);
  }

  /**
   * Splits the stream into protocol lines.
   *
   * A `data` chunk is whatever the OS handed over — it can hold half a line,
   * three lines, or a line split mid-word. Treating one chunk as one message
   * is the classic bug here, and it shows up only under load, when a long
   * tool body finally exceeds the pipe buffer.
   */
  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;

    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    // The BOM a Windows pipe can prepend is not valid JSON, and a dropped
    // first line looks exactly like a hung agent.
    const clean = line.replace(/^﻿/, "");
    try {
      const event = JSON.parse(clean) as AgentEvent;
      // Deltas are the bulk of the traffic and say nothing useful here.
      if (event.kind !== "delta" && event.kind !== "reasoning") {
        log(`← ${event.kind}`);
      }
      this.eventEmitter.fire(event);
    } catch {
      // Surfaced rather than dropped: silence is the one failure mode that
      // leaves a user staring at a spinner.
      this.eventEmitter.fire({ kind: "error", text: clean });
    }
  }

  private teardown(reason: string): void {
    if (!this.child) {
      return; // already torn down; exit and error can both land
    }
    this.child = undefined;
    this.currentWorkspace = undefined;
    this.stopping = false;
    this.exitEmitter.fire(reason);
  }
}

/** The `measycode.binaryPath` setting, trimmed; empty means "use the PATH". */
function configuredBinaryPath(): string {
  return vscode.workspace
    .getConfiguration("measycode")
    .get<string>("binaryPath", "")
    .trim();
}

/**
 * spawn as a promise that settles on the first thing the child does: Node's
 * `spawn` event when it started, `error` when it could not. Without this the
 * caller has no way to tell "not installed" from "installed and quiet", since
 * spawn itself throws nothing for a missing executable.
 */
function spawnOrThrow(
  binary: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, options) as ChildProcessWithoutNullStreams;
    child.once("spawn", () => resolve(child));
    child.once("error", reject);
  });
}
