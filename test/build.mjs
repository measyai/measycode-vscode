/**
 * Bundles the harness with `vscode` aliased to the stub, so the real agent.ts
 * can run in plain Node. The alias is the whole trick: without it the import
 * fails, and with a hand-written copy of the bridge the test would prove
 * nothing about what ships.
 */
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["test/harness.ts"],
  bundle: true,
  outfile: "test/out/harness.mjs",
  platform: "node",
  format: "esm",
  target: "node18",
  alias: { vscode: "./test/vscode-stub.mjs" },
  logLevel: "warning",
});
