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
// The endpoint's judgement and the browser's send are RUN, not read: both
// were split from their wiring (report-error/handler.ts, crashReport.js) so
// that authentication, the byte ceiling, two reports racing inside the same
// minute and a send that rejects are exercised here rather than asserted
// about as source text. What stays a text check is wiring and SQL, where
// there is nothing to execute.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { TABS } from "./data.js";
import {
  CATEGORIES, ROUTE_IDS, COMPONENT_IDS, APP_VERSION_RE, MAX_BODY_BYTES,
  categorize, cleanAppVersion, validateCrashReport, minuteBucket
} from "../../supabase/functions/_shared/crashReport.ts";
import { handleReport, readBounded, logMessage, LOG_FUNCTION_NAME, FILED, RATE_LIMITED } from "../../supabase/functions/report-error/handler.ts";
import { makeReportCrash, crashBody } from "./crashReport.js";

const read = p => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const MODULE_TS = "supabase/functions/_shared/crashReport.ts";
const MODULE_JS = "vite-app/src/crashReport.js";
const FUNCTION = "supabase/functions/report-error/index.ts";
const HANDLER = "supabase/functions/report-error/handler.ts";
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
  for (const file of [MODULE_JS, MODULE_TS, FUNCTION, HANDLER]) {
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
  for (const file of [MODULE_TS, FUNCTION, HANDLER, MODULE_JS]) {
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
  const fn = read(HANDLER);
  assert.match(fn, /minute_bucket: minuteBucket\(deps\.now\(\)\)/,
    "the bucket is stamped from the clock the wiring hands in");
  assert.match(read(FUNCTION), /now: \(\) => new Date\(\)/, "and that clock is this server's");
  assert.doesNotMatch(fn, /minute_bucket:\s*(body|b|parsed|checked|report)/, "never taken from the body");
  assert.match(fn, /user_id: user\.id/, "and the account comes from the verified token");
  assert.doesNotMatch(fn, /user_id:\s*(body|b|parsed|checked|report)/);
});

test("the wiring hands the handler a clock, a token check and the one call — and nothing else", () => {
  // The ordering and the ceiling are RUN below, against handler.ts. What is
  // left to read is the wiring: that the handler is reached, that the byte
  // ceiling is the bytes rather than the caller's Content-Length, and that
  // no second rate limit was invented in the file that has the client.
  const fn = read(FUNCTION);
  assert.match(fn, /handleReport\(req, \{/, "index.ts is wiring; the judgement is handler.ts");
  assert.doesNotMatch(fn.replace(/^\s*\/\/.*$/gm, ""), /content-length/i,
    "Content-Length is the caller's word for the size, not the check");
  assert.doesNotMatch(fn, /arrayBuffer\(\)/, "the body is read bounded, in the handler");
  assert.match(read(HANDLER), /export async function readBounded/);
  // Four short identifiers and their keys sit far under the ceiling.
  assert.ok(new TextEncoder().encode(JSON.stringify(good())).byteLength < MAX_BODY_BYTES / 2);
});

test("the browser never writes the table, and a second report in a minute is swallowed", () => {
  const fn = read(FUNCTION);
  assert.match(fn, /SUPABASE_SERVICE_ROLE_KEY/, "the service role does the insert");
  assert.match(fn, /admin\.rpc\("file_browser_crash"/, "through the one function that is one transaction");
  assert.doesNotMatch(fn, /admin\.from\("browser_crashes"\)/,
    "a direct insert is a request of its own, and cannot share a transaction with another");
  // No error CODE decides the outcome here any more. A 23505 raised at this
  // function is some other constraint failing, not this account's minute.
  assert.doesNotMatch(read(HANDLER), /23505/,
    "handler.ts reads a uniqueness code, and a collision on another table would pass as the rate limit");
  // The limit is the insert. A count first would let two crashing tabs both
  // read zero and both write. (Two racing reports are run, below.)
  for (const file of [FUNCTION, HANDLER]) {
    assert.doesNotMatch(read(file), /\.select\(\s*["']count|head:\s*true/,
      `${file} counts rows — that is a read-then-write rate limit`);
  }
  const draft = read(DRAFT);
  assert.match(draft, /primary key \(user_id, minute_bucket\)/, "the limit is a key, not a query");
  assert.match(draft, /revoke insert, update, delete on public\.browser_crashes from anon, authenticated;/);
  assert.doesNotMatch(draft, /for (insert|update|delete)/i, "no write policy for a signed-in account");
  assert.match(draft, /alter table public\.browser_crashes enable row level security;/);
  assert.match(draft, /p\.role = 'Admin'/, "read by Admins, like function_errors");
  // function_errors keeps its own rules: the draft writes one row into it
  // and changes nothing else about it.
  const sql = draft.replace(/^\s*--.*$/gm, "");
  assert.doesNotMatch(sql, /(alter|drop) (table|policy)[^;]*function_errors/i,
    "the draft alters function_errors, and the office's log keeps its own rules");
  assert.doesNotMatch(sql, /create policy[^;]*function_errors/i);
});

test("the ledger row and the office's copy are one transaction, not two requests", () => {
  // Two PostgREST inserts cannot be wrapped in a transaction: each request
  // is its own. So the office's copy could fail after the ledger row landed,
  // and the crash would be missing from the only screen anyone reads while
  // the primary key refused every retry for the rest of the minute. A
  // function body IS a transaction; both inserts live inside this one.
  const sql = read(DRAFT).replace(/^\s*--.*$/gm, "");
  const body = /create function public\.file_browser_crash\b[\s\S]*?\n\$\$;/.exec(sql);
  assert.ok(body, "the draft has no file_browser_crash function");
  const fn = body[0];
  assert.match(fn, /insert into public\.browser_crashes/, "the ledger row is inside it");
  assert.match(fn, /insert into public\.function_errors/, "and so is the office's copy");
  // The collision is read off the LEDGER insert alone -- ON CONFLICT on its
  // own named key, row_count = 0 -- not off an exception handler wrapped
  // around the whole body. An exception handler would have turned a
  // uniqueness failure on the office's copy into 'rate_limited': a crash
  // answered "filed", invisible on the screen, with the minute spent.
  assert.ok(fn.includes("on conflict (user_id, minute_bucket) do nothing"),
    "the rate limit is the ledger's own key, and only that key");
  assert.ok(/get diagnostics [a-z_]+ = row_count/.test(fn), "and the skip is what returns rate_limited");
  assert.ok(!/\bexception\b/i.test(fn),
    "an exception block covers the whole body, so another table's failure comes back as the rate limit");
  assert.match(fn, /return 'rate_limited'/);
  assert.doesNotMatch(fn, /select\s+count|exists\s*\(/i, "no read-then-write crept in");
  assert.match(fn, /security definer/);
  assert.match(fn, /set search_path = public, pg_temp/, "a definer function pins its search_path");
  const sig = "public.file_browser_crash(uuid, text, text, text, text, text)";
  assert.ok(sql.includes(`revoke all on function ${sig} from anon, authenticated;`),
    "a signed-in account keeps execute on the function that writes the office's log");
  assert.ok(sql.includes(`grant execute on function ${sig} to service_role;`),
    "the service role is the only caller");
  assert.doesNotMatch(sql, /grant execute[^;]*file_browser_crash[^;]*to (anon|authenticated)/,
    "a signed-in account can call the function that writes the log the office trusts");

  // The office's copy is built in SQL out of columns the check constraints
  // have already vetted, so nothing free-text reaches function_errors even
  // if report-error ships with a bug. Which makes it a second copy of
  // logMessage(), so: read both and compare the sentence they produce.
  const joiner = /'ErrorBoundary \(' \|\| p_component_id \|\| '\) on ' \|\| p_route_id \|\| '([^']*)' \|\| p_error_category/.exec(fn);
  assert.ok(joiner, "the log sentence in SQL is not the shape the test can compare");
  const r = good();
  assert.equal(`ErrorBoundary (${r.component_id}) on ${r.route_id}${joiner[1]}${r.error_category}`,
    logMessage(r), "the sentence SQL writes and the one handler.ts builds have drifted");
  assert.match(fn, /'browser'/, "filed under the name the panel's filter knows");
  assert.equal(LOG_FUNCTION_NAME, "browser");
  // ASCII on both sides, so the two copies cannot drift through an encoding
  // on the way to the applier.
  assert.doesNotMatch(logMessage(r), /[^ -~]/, "the log sentence is ASCII in both copies");
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
  const send = js.slice(js.indexOf("export function makeReportCrash"));
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
  assert.doesNotMatch(js, /^import\b/m, "and the module loads without a browser, so the send can be run");
  assert.match(read("vite-app/src/crashSend.js"), /makeReportCrash\(body => sbClient\.functions\.invoke\("report-error", \{ body \}\)\)/,
    "the real client is bound in one line, outside the tested module");
  assert.match(read("vite-app/src/components/common.jsx"), /import \{ reportCrash \} from "\.\.\/crashSend\.js";/);
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

// ─────────────────────────────────────────────────────────────────────────
// The endpoint, run rather than read.
//
// handler.ts holds every decision and no client, so the paths that matter —
// an unauthenticated caller, a body that keeps coming, two tabs crashing in
// the same second, a database that says no — are exercised here against
// fakes that behave the way Postgres and a stream actually do.

const encode = text => new TextEncoder().encode(text);

/**
 * A request body that records exactly what the handler asked of it.
 *
 * Duck-typed rather than a real ReadableStream on purpose: a real one reads
 * a chunk ahead to fill its queue, which would hide the thing being measured
 * — how much this handler pulls before it stops. realStream below runs the
 * reader against the genuine type as well, so both are covered.
 */
const streamOf = chunks => {
  const state = { reads: 0, cancelled: false, locked: false };
  let at = 0;
  const body = {
    getReader() {
      state.locked = true;
      return {
        read: async () => {
          state.reads++;
          return at < chunks.length ? { done: false, value: chunks[at++] } : { done: true, value: undefined };
        },
        cancel: async () => { state.cancelled = true; },
        releaseLock() {}
      };
    }
  };
  return { body, state };
};

/** The same bytes as a real ReadableStream, for the reader's own tests. */
const realStream = chunks => new ReadableStream({
  start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); }
});

const reqOf = (body, auth = "Bearer a-real-token") => ({
  method: "POST",
  headers: { get: n => (n.toLowerCase() === "authorization" ? auth : null) },
  body
});

const jsonReq = obj => {
  const { body, state } = streamOf([encode(JSON.stringify(obj))]);
  return { req: reqOf(body), state };
};

/**
 * file_browser_crash, standing in for the database function: the primary key,
 * both writes, and — the point of it — the transaction around them. logFails
 * makes the office's copy fail; the ledger row must then not exist either.
 */
const fakeDb = ({ logFails = false } = {}) => {
  const crashes = new Map();
  const log = [];
  return {
    crashes,
    log,
    fileCrash: async row => {
      // A real call is a round trip: yield, so two callers interleave here
      // the way two requests would.
      await Promise.resolve();
      const key = `${row.user_id}|${row.minute_bucket}`;
      if (crashes.has(key)) return { outcome: "rate_limited", error: null };
      // Inside the transaction from here: nothing written is kept unless
      // everything is.
      const staged = { ...row };
      if (logFails) return { outcome: null, error: { code: "42501", message: "permission denied for table function_errors" } };
      crashes.set(key, staged);
      log.push({
        function_name: LOG_FUNCTION_NAME,
        message: logMessage(row),
        context: {
          error_category: row.error_category,
          route_id: row.route_id,
          component_id: row.component_id,
          app_version: row.app_version,
          source: "browser"
        }
      });
      return { outcome: "filed", error: null };
    },
    insertLog: async row => { log.push(row); return null; }
  };
};

const depsOf = (db, { user = { id: "user-1" }, now = "2026-09-12T10:04:30.500Z" } = {}) => ({
  getUser: async () => user,
  fileCrash: db.fileCrash,
  insertLog: db.insertLog,
  now: () => new Date(now)
});

test("an unauthenticated report is refused before its body is read at all", async () => {
  const db = fakeDb();
  const { req, state } = jsonReq(good());
  const res = await handleReport(req, depsOf(db, { user: null }));
  assert.equal(res.status, 401);
  assert.equal(state.locked, false, "the body was opened before the caller was known");
  assert.equal(state.reads, 0, "an unauthenticated flood must cost this function no memory");
  assert.equal(db.crashes.size, 0);
  assert.equal(db.log.length, 0, "and no log row either, or the log becomes the flood");
});

test("a body over the ceiling is refused mid-upload, not buffered and then measured", async () => {
  const db = fakeDb();
  // Forty chunks of a quarter-kilobyte: 10KB offered to a 512-byte endpoint.
  const chunks = Array.from({ length: 40 }, () => encode("x".repeat(256)));
  const { body, state } = streamOf(chunks);
  const res = await handleReport(reqOf(body), depsOf(db));
  assert.equal(res.status, 413);
  assert.equal(state.reads, 3, `read ${state.reads} of 40 chunks — it stopped the moment it passed ${MAX_BODY_BYTES} bytes, or it did not`);
  assert.ok(state.cancelled, "the upload is cancelled, not drained");
  assert.equal(db.crashes.size, 0);
  assert.equal(db.log.length, 0);
  // And the reader itself: the ceiling is inclusive, and a body at it parses.
  const atTheLimit = await readBounded(realStream([encode("x".repeat(MAX_BODY_BYTES))]), MAX_BODY_BYTES);
  assert.equal(atTheLimit?.byteLength, MAX_BODY_BYTES, "the ceiling is inclusive, against a real stream");
  assert.equal(await readBounded(realStream([encode("x".repeat(MAX_BODY_BYTES + 1))]), MAX_BODY_BYTES), null);
  // Chunks are rejoined in order, so a split body still parses.
  const split = await readBounded(realStream([encode('{"a":'), encode("1}")]), MAX_BODY_BYTES);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(split)), { a: 1 });
  // A body arriving a byte at a time is still measured as a whole.
  const drip = streamOf(Array.from({ length: MAX_BODY_BYTES + 1 }, () => encode("x")));
  assert.equal(await readBounded(drip.body, MAX_BODY_BYTES), null, "a slow sender is not a way past the ceiling");
  assert.ok(drip.state.cancelled);
});

test("a report is filed under the server's account and minute, whatever the body claims", async () => {
  const db = fakeDb();
  const { req } = jsonReq({
    ...good(),
    user_id: "00000000-0000-0000-0000-000000000000",
    minute_bucket: "1999-01-01T00:00",
    message: "Ticket T-1042 failed",
    stack: "at Foo (https://app.test/approve?token=abc)"
  });
  const res = await handleReport(req, depsOf(db));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  const [row] = [...db.crashes.values()];
  assert.equal(row.user_id, "user-1", "the account is the verified one");
  assert.equal(row.minute_bucket, "2026-09-12T10:04", "and the minute is this server's clock");
  assert.deepEqual(Object.keys(row).sort(),
    ["app_version", "component_id", "error_category", "minute_bucket", "route_id", "user_id"]);
  assert.doesNotMatch(JSON.stringify(row) + JSON.stringify(db.log), /token=abc|T-1042|https/,
    "a word the browser sent reached the database");
});

test("two reports racing inside the same minute write one row and tell nobody twice", async () => {
  const db = fakeDb();
  const send = () => handleReport(jsonReq(good()).req, depsOf(db));
  const [a, b] = await Promise.all([send(), send()]);
  assert.equal(db.crashes.size, 1, "the rate limit is the key, and two tabs cannot both pass it");
  const rateLimited = [a, b].filter(r => r.body.rateLimited);
  assert.equal(rateLimited.length, 1, "exactly one of the two is the collision");
  assert.equal(a.status, 200);
  assert.equal(b.status, 200, "and neither caller is given an error to handle");
  assert.equal(db.log.length, 1, "a crash-looping phone must not fill the log it was meant to inform");
  // Ten at once, the way a crash loop across tabs actually arrives.
  const many = await Promise.all(Array.from({ length: 10 }, send));
  assert.equal(db.crashes.size, 1, "still one row for the minute");
  assert.equal(many.filter(r => r.status === 200).length, 10);
  assert.equal(db.log.length, 1);
  // The next minute is its own row, so the log keeps working.
  await handleReport(jsonReq(good()).req, depsOf(db, { now: "2026-09-12T10:05:01.000Z" }));
  assert.equal(db.crashes.size, 2);
  assert.equal(db.log.length, 2);
});

test("the office sees a browser crash in the log it already reads", async () => {
  const db = fakeDb();
  await handleReport(jsonReq(good()).req, depsOf(db));
  assert.equal(db.log.length, 1);
  const [entry] = db.log;
  assert.equal(entry.function_name, LOG_FUNCTION_NAME,
    "filed under one name, so the panel's filter can pick browser crashes out");
  assert.equal(entry.message, logMessage(good()));
  assert.equal(entry.message, "ErrorBoundary (screen) on board: chunk-load");
  assert.deepEqual(entry.context, { ...good(), source: "browser" });
  // The sentence is built from slugs the allowlists hold, and nothing else.
  const slugs = [...CATEGORIES, ...ROUTE_IDS, ...COMPONENT_IDS];
  for (const word of entry.message.split(/[^0-9A-Za-z-]+/).filter(Boolean)) {
    assert.ok(word === "ErrorBoundary" || word === "on" || slugs.includes(word),
      `the log line carries "${word}", which is not an allowlisted slug`);
  }
  // Db.listFunctionErrors is the read the office already has; it is untouched.
  const dbJs = read("vite-app/src/db.js");
  assert.match(dbJs, /from\("function_errors"\)\.select\("\*"\)/);
  assert.doesNotMatch(dbJs, /browser_crashes/,
    "the browser's ledger is not a second read for the office to learn");
});

test("a crash that cannot be filed is itself reported, and never half-filed", async () => {
  const refuses = { ...fakeDb(), fileCrash: async () => ({ outcome: null, error: { code: "42501", message: "permission denied for table browser_crashes" } }) };
  const res = await handleReport(jsonReq(good()).req, depsOf(refuses));
  assert.equal(res.status, 400);
  assert.equal(refuses.log.length, 1, "a reporting endpoint that fails quietly is the same blindness");
  assert.equal(refuses.log[0].function_name, "report-error");

  // The half that used to be possible, and is the whole reason for the rpc:
  // the ledger row lands, the office's copy does not, and the primary key
  // then refuses every retry for the rest of the minute. A crash invisible
  // in the only screen anyone reads, behind a rate limit that thinks it did
  // its job. Both rows are one transaction, so neither is written.
  const db = fakeDb({ logFails: true });
  const half = await handleReport(jsonReq(good()).req, depsOf(db));
  assert.equal(half.status, 400, "the caller is told the pair could not be written");
  assert.equal(db.crashes.size, 0, "no ledger row without the office's copy");
  assert.equal(db.log.filter(r => r.function_name === LOG_FUNCTION_NAME).length, 0);
  assert.equal(db.log.filter(r => r.function_name === "report-error").length, 1,
    "and the failure itself is reported");
  // The minute is still free, so the next report is not rate-limited into
  // the same silence.
  const working = fakeDb();
  const retry = await handleReport(jsonReq(good()).req, depsOf(working));
  assert.equal(retry.status, 200);
  assert.equal(working.crashes.size, 1);
});

test("a uniqueness failure that is not this account's minute is a failure, not the rate limit", async () => {
  // The ledger insert carries ON CONFLICT on its own key, so "rate_limited"
  // can only ever mean that key. A 23505 raised AT the caller is therefore
  // some other constraint -- the office's copy, a migration half-applied --
  // and the whole transaction rolled back with it. Reading the code as the
  // rate limit would answer 200 ok to a crash that was written nowhere, and
  // spend a minute that was never taken.
  const db = fakeDb();
  const collides = {
    ...db,
    fileCrash: async () => ({
      outcome: null,
      error: { code: "23505", message: "duplicate key value violates unique constraint function_errors_pkey" }
    })
  };
  const res = await handleReport(jsonReq(good()).req, depsOf(collides));
  assert.equal(res.status, 400, "a 23505 from another constraint was answered ok");
  assert.notEqual(res.body.rateLimited, true, "and reported as the rate limit landing");
  assert.equal(db.crashes.size, 0, "nothing on the ledger");
  assert.equal(db.log.filter(r => r.function_name === "report-error").length, 1,
    "the failure reaches the office instead of being swallowed as a quiet success");
  // And because nothing was written, the minute is still free.
  const working = fakeDb();
  const retry = await handleReport(jsonReq(good()).req, depsOf(working));
  assert.equal(retry.status, 200);
  assert.equal(working.crashes.size, 1, "the retry is the report that lands");
});

test("an answer the database function never gives is a failure, not a success", async () => {
  // outcome is the function's own word. Anything else — a renamed rpc, a
  // migration half-applied, null from PostgREST — must not read as filed.
  for (const outcome of [null, "", "ok", "FILED", undefined]) {
    const db = { ...fakeDb(), fileCrash: async () => ({ outcome, error: null }) };
    const res = await handleReport(jsonReq(good()).req, depsOf(db));
    assert.equal(res.status, 400, `outcome ${JSON.stringify(outcome)} was treated as filed`);
    assert.equal(db.log[0].function_name, "report-error");
  }
  assert.equal(FILED, "filed");
  assert.equal(RATE_LIMITED, "rate_limited");
});

test("a body that is not a report is refused without a write", async () => {
  const db = fakeDb();
  const broken = await handleReport(reqOf(streamOf([encode("{not json")]).body), depsOf(db));
  assert.equal(broken.status, 400);
  assert.equal(broken.body.error, "Not a report.");
  const empty = await handleReport(reqOf(null), depsOf(db));
  assert.equal(empty.status, 400);
  const wrong = await handleReport(jsonReq({ ...good(), route_id: "/approve?token=abc" }).req, depsOf(db));
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, "Unknown route_id.");
  assert.doesNotMatch(JSON.stringify(wrong.body), /token/, "the refusal does not quote the caller");
  assert.equal(db.crashes.size, 0);
  assert.equal(db.log.length, 0);
});

test("a send that fails is a send that happened, as far as the error screen is concerned", async () => {
  const unhandled = [];
  const watch = reason => unhandled.push(reason);
  process.on("unhandledRejection", watch);
  try {
    const sent = [];
    const ok = makeReportCrash(body => { sent.push(body); return Promise.resolve({ data: { ok: true } }); });
    ok(new TypeError("Failed to fetch"), "board", "screen");
    assert.deepEqual(Object.keys(sent[0]).sort(), ["app_version", "component_id", "error_category", "route_id"]);
    assert.equal(sent[0].error_category, "network");

    // The three ways a send goes wrong, none of which may reach the caller.
    const rejects = makeReportCrash(() => Promise.reject(new Error("offline")));
    assert.doesNotThrow(() => rejects(new Error("boom"), "job", "screen"));
    const throws = makeReportCrash(() => { throw new Error("no client"); });
    assert.doesNotThrow(() => throws(new Error("boom"), "job", "screen"));
    const notAPromise = makeReportCrash(() => undefined);
    assert.doesNotThrow(() => notAPromise(new Error("boom"), "job", "screen"));

    // An unusable build stamp is not sent at all.
    globalThis.__APP_VERSION__ = "···";
    const never = [];
    makeReportCrash(b => never.push(b))(new Error("boom"), "board", "screen");
    assert.equal(never.length, 0, "a stamp the server would refuse is not worth the round trip");
    assert.equal(crashBody(new Error("boom"), "board", "screen").app_version, "");
    delete globalThis.__APP_VERSION__;

    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(unhandled, [], "a rejected report must not surface as an unhandled rejection");
  } finally {
    process.off("unhandledRejection", watch);
    delete globalThis.__APP_VERSION__;
  }
});
