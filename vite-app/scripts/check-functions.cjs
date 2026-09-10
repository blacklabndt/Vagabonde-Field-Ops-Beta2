// Type-checks every Edge Function with Deno's own checker, the way the
// runtime would if it checked (it does not: the deploy bundler strips types
// and boots whatever is left). Nothing in vite-app runs TypeScript, so Deno
// comes through npx, pinned: its TypeScript is what decides, and 2.9.6
// carries TypeScript 6. The first run downloads it into npm's cache; every
// run after that is the check alone, ten seconds or so.
//
// --no-lock: the check would otherwise write a deno.lock at the repo root,
// which the repo has no Deno configuration to own. --node-modules-dir=none:
// chat-push imports web-push from npm, and with a package.json at the root
// Deno would look for it in a node_modules folder there; "none" keeps it in
// Deno's own cache instead.
//
// Every function's index.ts is an entry, found here rather than listed, so a
// new function is checked the day it exists. The _shared modules are reached
// through the functions that import them.

const { readdirSync, existsSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DENO = "deno@2.9.6";
const root = path.resolve(__dirname, "..", "..");
const dir = path.join(root, "supabase", "functions");
const entries = readdirSync(dir, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith("_"))
  .map(d => path.join("supabase", "functions", d.name, "index.ts"))
  .filter(p => existsSync(path.join(root, p)));

if (!entries.length) {
  console.error("check-functions: no functions found under supabase/functions");
  process.exit(1);
}

// npx is run as the script it is (node itself running npm's npx-cli.js, found
// beside the node binary) rather than as the npx.cmd shim, which on Windows
// needs a shell to start and, run through one, concatenates its arguments
// unescaped. Where that script is not beside node, the shim it is.
const args = ["--yes", DENO, "check", "--no-lock", "--node-modules-dir=none", ...entries];
const npxCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
const r = existsSync(npxCli)
  ? spawnSync(process.execPath, [npxCli, ...args], { cwd: root, stdio: "inherit" })
  : spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", args,
    { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
if (r.error) {
  console.error(`check-functions: could not run ${DENO} through npx: ${r.error.message}`);
  process.exit(1);
}
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`check-functions: ${entries.length} functions type-check under ${DENO}`);
