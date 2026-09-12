// The browser crash report: four identifiers, and nothing else, ever.
//
// The rule this file exists to keep is a security rule, not a style one.
// Approval tokens are stored hashed and exist in the clear only inside an
// emailed link; OAuth codes arrive the same way. Both live in URLs, and a
// React error message or component stack can carry a URL. So the report
// carries no message, no stack and no URL at any level — and because that
// is easy to undo by adding one helpful field, the tests below read the
// module, the function, the browser twin and the table's own constraints
// and fail if any of the four learns a new one.
//
// The pure code is exercised through the TypeScript module and the browser
// copy is held to it by the twin check, the way askTwins.test.mjs does it.
// The send itself cannot be imported here (it pulls in config.js, which
// wants a browser's import.meta.env), so its shape is read as text.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { TABS } from "./data.js";
import {
  CATEGORIES, ROUTE_IDS, COMPONENT_IDS, APP_VERSION_RE, MAX_BODY_BYTES,
  categorize, cleanAppVersion, validateCrashReport, minuteBucket
} from "../../supabase/functions/_shared/crashReport.ts";

const read = p => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const MODULE_TS = "supabase/functions/_shared/crashReport.ts";
const MODULE_JS = "vite-app/src/crashReport.js";
const FUNCTION = "supabase/functions/report-error/index.ts";
const DRAFT = "supabase/handover/draft-browser-crashes.sql";

const CORE = /\/\/ ═══ shared core[^\n]*\n([\s\S]*?)\/\/ ═══ end shared core ═══/;
const coreOf = file => {
  const m = CORE.exec(read(file));
  assert.ok(m, `${file} has no shared core markers`);
  return m[1];
};
const shapeOf = code => code.split("\n")
  .map(l => l.replace(/\s+/g, " ").replace(/ (?=[),;])/g, "").trim())
  .filter(Boolean).join("\n");

const good = () => ({
  error_category: "chunk-load",
  route_id: "board",
  component_id: "screen",
  app_version: "0.93-beta 2 - a1b2c3d - 2026-09-12"
});

test("the crash report's rules are the same code in the browser and in the function", () => {
  const js = coreOf(MODULE_JS);
  const ts = coreOf(MODULE_TS);
  assert.ok(js.includes("export function categorize"), "the core must hold categorize itself");
  assert.ok(js.includes("export const ROUTE_IDS"), "and the allowlists it judges against");
  assert.equal(shapeOf(stripTypeScriptTypes(ts)), shapeOf(js));
  assert.doesNotMatch(read(MODULE_TS), /^import\b/m, "erasable and import-free, like the modules beside it");
});

test("a route id is a tab key, never a URL", () => {
  // TABS is the app's own route table. The report says which screen was on,
  // in the app's words — location.pathname, location.search and location.hash
  // are the three places a token would be, and none of them is read.
  const expected = [...TABS.map(t => t.key), "root", "unknown"];
  assert.deepEqual([...ROUTE_IDS].sort(), [...expected].sort(),
    "ROUTE_IDS and TABS have drifted — move both together");
  for (const file of [MODULE_JS, MODULE_TS, FUNCTION]) {
    assert.doesNotMatch(read(file), /location\.(href|pathname|search|hash)|window\.location|document\.referrer/,
      `${file} reads the URL — the one thing the report must never carry`);
  }
});

test("nothing free-text is accepted, named or otherwise", () => {
  // The four fields, and the fact that there are only four. A fifth added
  // without thinking — a message, a stack, a "detail" — fails here.
  const checked = validateCrashReport({ ...good(), message: "boom", stack: "at Foo (/approve?token=abc)" });
  assert.ok("report" in checked);
  assert.deepEqual(Object.keys(checked.report).sort(),
    ["app_version", "component_id", "error_category", "route_id"]);
  assert.equal(checked.report.error_category, "chunk-load");
  // And the words themselves appear nowhere in either file.
  for (const file of [MODULE_TS, FUNCTION, MODULE_JS]) {
    const body = read(file).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    assert.doesNotMatch(body, /\b(componentStack|error\.stack|errorInfo|\.stack\b)/,
      `${file} touches a stack`);
  }
});

test("an unknown value is refused, not coerced", () => {
  for (const [field, bad] of [
    ["error_category", "made-up"],
    ["route_id", "/approve?token=abc"],
    ["component_id", "Blueprint"],
    ["app_version", "https://x.test/y?code=1"]
  ]) {
    const checked = validateCrashReport({ ...good(), [field]: bad });
    assert.ok("error" in checked, `${field} accepted ${bad}`);
    assert.equal(checked.error, `Unknown ${field}.`);
    // The refusal never quotes what was sent back at the caller.
    assert.doesNotMatch(checked.error, /token|https|made-up|Blueprint/);
  }
  for (const notABody of [null, undefined, "", 0, "a string", []]) {
    const checked = validateCrashReport(notABody);
    assert.ok("error" in checked, `${JSON.stringify(notABody)} accepted as a body`);
  }
  // An array is an object to typeof; it still holds none of the four.
  assert.ok("error" in validateCrashReport([]));
});

test("the build stamp is folded to a charset, and an unfoldable one is refused", () => {
  assert.equal(cleanAppVersion("0.93-beta 2 · a1b2c3d · 2026-09-12"),
    "0.93-beta 2 - a1b2c3d - 2026-09-12", "the stamp's separator folds to a hyphen");
  assert.ok(APP_VERSION_RE.test(cleanAppVersion("0.93-beta 2 · a1b2c3d · 2026-09-12")));
  // Folded, not dropped: two different builds cannot collide on the fold.
  assert.notEqual(cleanAppVersion("a·b"), cleanAppVersion("ab"));
  // A URL, a token, a quote and a newline all come out unusable or harmless.
  assert.doesNotMatch(cleanAppVersion("https://x.test/a?token=sha256:deadbeef"), /[:?/]/);
  assert.doesNotMatch(cleanAppVersion('0.93" or 1=1 --'), /"/);
  assert.doesNotMatch(cleanAppVersion("0.93\nX-Injected: 1"), /\n/);
  assert.equal(cleanAppVersion("·"), "", "nothing usable left is nothing sent");
  assert.equal(cleanAppVersion(""), "");
  assert.equal(cleanAppVersion(null), "");
  assert.equal(cleanAppVersion(undefined), "");
  assert.equal(cleanAppVersion(123), "");
  assert.equal(cleanAppVersion("x".repeat(200)).length, 60, "and it is bounded");
  assert.ok("error" in validateCrashReport({ ...good(), app_version: "x".repeat(61) }));
});

test("a crash is categorised without its words leaving the device", () => {
  // Vite reports a chunk that would not load as a TypeError, and on a field
  // device that is the crash that actually happens. It is asked first.
  const chunk = new TypeError("Failed to fetch dynamically imported module: /assets/Ticket-abc.js");
  assert.equal(categorize(chunk), "chunk-load");
  assert.equal(categorize({ name: "ChunkLoadError", message: "" }), "chunk-load");
  assert.equal(categorize(new TypeError("Failed to fetch")), "network");
  assert.equal(categorize(new TypeError("x is not a function")), "type-error");
  assert.equal(categorize(new RangeError("Invalid array length")), "range-error");
  assert.equal(categorize(new ReferenceError("x is not defined")), "reference-error");
  assert.equal(categorize(new SyntaxError("Unexpected token")), "syntax-error");
  assert.equal(categorize(new Error("Ticket T-1042 for Pembina failed to save")), "unknown");
  assert.equal(categorize(null), "unknown");
  assert.equal(categorize(undefined), "unknown");
  assert.equal(categorize("a string"), "unknown");
  // Whatever went in, what comes out is one of the seven and nothing else.
  for (const e of [chunk, new Error("Ticket T-1042 for Pembina"), null, 7]) {
    assert.ok(CATEGORIES.includes(categorize(e)), "an invented category");
  }
});

test("the minute a report is filed under is the server's, not the browser's", () => {
  assert.equal(minuteBucket(new Date("2026-09-12T10:03:59.999Z")), "2026-09-12T10:03");
  assert.equal(minuteBucket(new Date("2026-09-12T10:04:00.000Z")), "2026-09-12T10:04");
  const fn = read(FUNCTION);
  assert.match(fn, /minute_bucket: minuteBucket\(new Date\(\)\)/,
    "the bucket is stamped in the function, from its own clock");
  assert.doesNotMatch(fn, /minute_bucket:\s*(body|b|checked)/, "never taken from the body");
  assert.match(fn, /user_id: user\.id/, "and the account comes from the verified token");
  assert.doesNotMatch(fn, /user_id:\s*(body|b|checked)/);
});

test("the function refuses before it reads, and reads before it parses", () => {
  const fn = read(FUNCTION);
  const signedIn = fn.indexOf('if (!user) return json({ error: "Not signed in" }, 401);');
  const bytes = fn.indexOf("req.arrayBuffer()");
  const cap = fn.indexOf("raw.byteLength > MAX_BODY_BYTES");
  const parse = fn.indexOf("JSON.parse");
  const insert = fn.indexOf(".insert(");
  assert.ok(signedIn > 0, "the function must refuse an unauthenticated caller");
  assert.ok(signedIn < bytes, "authentication is checked before the body is read at all");
  assert.ok(bytes < cap && cap < parse, "the byte ceiling is enforced on the bytes, before parsing");
  assert.ok(parse < insert, "and nothing is written before it is validated");
  assert.match(fn, /const checked = validateCrashReport\(body\);/);
  assert.ok(fn.indexOf("validateCrashReport") < insert);
  // Content-Length is the caller's word for the size; it is not the check.
  // Read past the comment that says so, to the code that does it.
  assert.doesNotMatch(fn.replace(/^\s*\/\/.*$/gm, ""), /content-length/i);
  // Four short identifiers and their keys sit far under the ceiling.
  assert.ok(new TextEncoder().encode(JSON.stringify(good())).byteLength < MAX_BODY_BYTES / 2);
});

test("the browser never writes the table, and a second report in a minute is swallowed", () => {
  const fn = read(FUNCTION);
  assert.match(fn, /SUPABASE_SERVICE_ROLE_KEY/, "the service role does the insert");
  assert.match(fn, /const UNIQUE_VIOLATION = "23505";/);
  assert.match(fn, /error\.code !== UNIQUE_VIOLATION/,
    "a primary-key collision is the rate limit working, not a failure");
  // The limit is the insert. A count first would let two crashing tabs both
  // read zero and both write.
  assert.doesNotMatch(fn, /\.select\(\s*["']count|head:\s*true/,
    "no read-then-write rate limit");
  const draft = read(DRAFT);
  assert.match(draft, /primary key \(user_id, minute_bucket\)/, "the limit is a key, not a query");
  assert.match(draft, /revoke insert, update, delete on public\.browser_crashes from anon, authenticated;/);
  assert.doesNotMatch(draft, /for (insert|update|delete)/i, "no write policy for a signed-in account");
  assert.match(draft, /alter table public\.browser_crashes enable row level security;/);
  assert.match(draft, /p\.role = 'Admin'/, "read by Admins, like function_errors");
  // function_errors keeps its own rules — this endpoint does not widen them.
  assert.doesNotMatch(draft.replace(/^\s*--.*$/gm, ""), /function_errors/,
    "the draft touches function_errors — the browser's log is its own table");
});

test("the table refuses what the module refuses, even if the function is redeployed wrong", () => {
  // The check constraints are the database's own copy of the allowlists.
  // Duplicated on purpose: a function can ship with a bug, and the row
  // should still be refused. Which makes them a drift risk, so: read both.
  const draft = read(DRAFT);
  const listIn = column => {
    const m = new RegExp(`check \\(${column} in \\(([^)]*)\\)\\)`).exec(draft);
    assert.ok(m, `${column} has no check constraint in the draft`);
    return m[1].split(",").map(s => s.trim().replace(/^'|'$/g, "")).sort();
  };
  assert.deepEqual(listIn("error_category"), [...CATEGORIES].sort());
  assert.deepEqual(listIn("route_id"), [...ROUTE_IDS].sort());
  assert.deepEqual(listIn("component_id"), [...COMPONENT_IDS].sort());
  // And the version charset is the same rule written twice.
  const sqlRe = /check \(app_version ~ '([^']*)'\)/.exec(draft);
  assert.ok(sqlRe, "app_version has no check constraint in the draft");
  assert.equal(sqlRe[1], APP_VERSION_RE.source,
    "the table's app_version rule and the module's have drifted");
  // The draft is a draft: it must not be filed as history until it is applied.
  assert.match(draft, /^-- DRAFT: not applied\./, "the handover file says what it is");
});

test("reporting a crash can never stop the error screen rendering", () => {
  const js = read(MODULE_JS);
  const send = js.slice(js.indexOf("export function reportCrash"));
  assert.match(send, /try \{/, "the whole send is guarded");
  assert.match(send, /\.catch\(\(\) => \{\}\)/, "and the rejection is swallowed");
  assert.doesNotMatch(send, /\bawait\b/, "nothing is awaited in the render path");
  assert.doesNotMatch(send, /throw\b/);

  const common = read("vite-app/src/components/common.jsx");
  const boundary = common.slice(common.indexOf("export class ErrorBoundary"));
  const caught = boundary.slice(boundary.indexOf("componentDidCatch"), boundary.indexOf("componentDidUpdate"));
  assert.match(caught, /reportCrash\(error, this\.props\.resetKey, this\.props\.boundary\)/,
    "the boundary reports where it crashed, from its own props");
  assert.doesNotMatch(caught, /reportCrash\([^)]*\binfo\b/, "the component stack is not passed on");
  assert.match(caught, /console\.error\("Screen crashed:", error, info\);/,
    "and the device's own console still gets everything");
  // Both mounts name themselves, or every crash would be filed as a screen.
  assert.match(read("vite-app/src/main.jsx"), /<ErrorBoundary resetKey="root" boundary="root">/);
  assert.match(read("vite-app/src/App.jsx"), /<ErrorBoundary resetKey=\{screen\} boundary="screen">/);
});

test("an unknown screen is filed as unknown rather than sent as itself", () => {
  // crashBody is the browser's, but it is the shared core's oneOf doing the
  // work, so the judgement is exercised here and the wiring read as text.
  const js = read(MODULE_JS);
  assert.match(js, /route_id: oneOf\(ROUTE_IDS, routeId\) \|\| "unknown"/);
  assert.match(js, /component_id: oneOf\(COMPONENT_IDS, componentId\) \|\| "screen"/);
  assert.match(js, /if \(!body\.app_version\) return;/,
    "an unusable build stamp is not worth a round trip");
  // A renamed screen, a context key, an injected string: all one word.
  assert.equal(validateCrashReport({ ...good(), route_id: "renamed" }).error, "Unknown route_id.");
  assert.ok("report" in validateCrashReport({ ...good(), route_id: "unknown" }));
});
