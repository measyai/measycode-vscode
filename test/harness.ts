/**
 * Runs the real agent.ts outside the extension host, against the real measy
 * binary. `vscode` is aliased to a stub at build time (see test/build.mjs);
 * everything else is the code that ships.
 *
 * Two things are worth proving, and they need different setups:
 *
 *   1. Line assembly. A pipe hands over whatever the OS had ready, so one
 *      `data` event is not one message. Fed directly with hostile chunks.
 *
 *   2. The process path — spawn, handshake, streaming, polite stop. Only a
 *      real child process exercises that, so this half talks to real measy.
 */

import { resolve } from "node:path";

import { Agent, type AgentEvent } from "../src/agent";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? "  — " + detail : ""}`);
  }
}

/** Reaches past `private` on purpose: the point is to test the shipped method. */
function feed(agent: Agent, chunk: string): void {
  (agent as unknown as { consume(c: string): void }).consume(chunk);
}

async function testLineAssembly(): Promise<void> {
  console.log("\nline assembly");

  const agent = new Agent();
  const seen: AgentEvent[] = [];
  agent.onEvent((e) => seen.push(e));

  const lines = [
    JSON.stringify({ kind: "ready", model: "measyai/cipher", dir: ".", auto: false }),
    JSON.stringify({ kind: "delta", text: "Grüße — äöü ß 🚀" }),
    JSON.stringify({ kind: "tool_body", text: "x".repeat(50_000) }),
    JSON.stringify({ kind: "turn_end" }),
  ];
  const wire = lines.join("\n") + "\n";

  // Seven characters at a time: small enough to land inside tokens, inside
  // string values, and between the braces of adjacent objects.
  for (let i = 0; i < wire.length; i += 7) {
    feed(agent, wire.slice(i, i + 7));
  }

  check("every line surfaced exactly once", seen.length === 4, `got ${seen.length}`);
  check("no line was reported as malformed", !seen.some((e) => e.kind === "error"));

  const delta = seen.find((e) => e.kind === "delta");
  check(
    "multi-byte text survives chunking",
    delta?.kind === "delta" && delta.text === "Grüße — äöü ß 🚀",
    delta?.kind === "delta" ? JSON.stringify(delta.text) : "no delta",
  );

  const body = seen.find((e) => e.kind === "tool_body");
  check(
    "a 50 KB line is reassembled whole",
    body?.kind === "tool_body" && body.text.length === 50_000,
    body?.kind === "tool_body" ? `${body.text.length} chars` : "no tool_body",
  );

  // Two objects arriving in one write is the other half of the same problem.
  const seen2: AgentEvent[] = [];
  const agent2 = new Agent();
  agent2.onEvent((e) => seen2.push(e));
  feed(agent2, JSON.stringify({ kind: "turn_start" }) + "\n" + JSON.stringify({ kind: "turn_end" }) + "\n");
  check("two objects in one chunk both surface", seen2.length === 2, `got ${seen2.length}`);

  agent.dispose();
  agent2.dispose();
}

async function testRealBinary(workspace: string): Promise<void> {
  console.log("\nreal measy -jsonl");

  const agent = new Agent();
  const seen: AgentEvent[] = [];
  let exitReason: string | undefined;

  agent.onEvent((e) => seen.push(e));
  agent.onExit((r) => (exitReason = r));

  const ready = new Promise<AgentEvent | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 30_000);
    agent.onEvent((e) => {
      if (e.kind === "ready" || e.kind === "auth_required") {
        clearTimeout(timer);
        resolve(e);
      }
    });
  });

  try {
    await agent.start(workspace);
  } catch (err) {
    check("agent starts", false, String(err));
    return;
  }

  check("agent reports running", agent.running);

  const first = await ready;
  check("handshake arrives", first !== undefined, "timed out after 30s");

  if (first?.kind === "ready") {
    check("ready names a model", Boolean(first.model), first.model);
    check("ready carries the catalogue", (first.models?.length ?? 0) > 0);
    // measy answers with an absolute path, so a relative argument has to be
    // resolved before comparing — and Windows is case-insensitive about drives.
    const normalise = (p: string) => resolve(p).replace(/\\/g, "/").toLowerCase();
    check(
      "ready echoes the workspace",
      normalise(first.dir) === normalise(workspace),
      `${first.dir} vs ${workspace}`,
    );
  } else if (first?.kind === "auth_required") {
    console.log("  note  CLI is signed out — skipping the ready assertions");
  }

  // The polite stop: close stdin, let the Go side return from its loop.
  await agent.stop();
  check("stop leaves nothing running", !agent.running);
  check("exit is reported", exitReason !== undefined, String(exitReason));

  agent.dispose();
}

async function main(): Promise<void> {
  const workspace = process.argv[2];
  if (!workspace) {
    console.error("usage: harness <workspace-dir>");
    process.exit(2);
  }

  await testLineAssembly();
  await testRealBinary(workspace);

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
