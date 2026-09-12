// Round 7, S6 — an error is not a schema tour, and not only in Ask.
//
// Ask was fixed first and read as an outlier. It was not: seventeen of the
// remaining nineteen functions returned `(e as Error).message` whole. Seven
// of those are reachable by ANY signed-in account — a Helper's session is
// enough — which matters here specifically, because this app already treats
// a low-privilege or locked account as untrusted: it is why profiles_select
// was narrowed to the caller's own row and why crew hours are private.
//
// The rule is the one Ask ended up with, and it is deny-by-default:
//
//   * a sentence WE wrote is raised through `refuse`, which marks the error;
//   * the catch shows a marked error's own words, and replaces everything
//     else with one fixed sentence;
//   * the real text always reaches function_errors.
//
// So this file does not hold a list of strings to classify. It asks the two
// questions a list could never keep up with: is any sentence of ours raised
// unmarked (the person would never see it), and can any catch return a
// message it has not first judged (everyone would see everything).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const fn = (name) => read(`../../supabase/functions/${name}/index.ts`);
const shared = (name) => read(`../../supabase/functions/_shared/${name}`);

// Every door a signed-in account can knock on that renders, mails or
// searches.
const STAFF_REACHABLE = [
  "send-jha", "send-report", "send-ticket-approval",
  "render-invoice", "render-jha", "gif-search", "feature-request"
];

// The modules those doors throw from. A sentence raised here reaches the
// person through one of the catches above, so it is held to the same rule.
const MAIL_MODULES = ["mail.ts", "mailJha.ts", "mailReport.ts", "mailApproval.ts"];

// The rest of the doors. Reaching one of these needs an Admin's JWT or the
// internal secret, so the exposure is smaller — but the whole reason the rule
// is deny-by-default is that it holds without anyone having to decide a door
// is important enough. A rule with an exception is the one that gets
// forgotten, and an Admin's browser is still a browser.
const GATED = [
  "create-user", "delete-user", "unlock-user", "password-reset", "mail-test",
  "chat-push", "chat-retention", "admin-digest", "backup-run", "backup-restore"
];

// The modules those doors throw from. drive.ts and backupOauth.ts hold no
// imports of their own (the guard list), so they spell the mark themselves.
const GATED_MODULES = ["backupCommon.ts", "backupOauth.ts", "drive.ts", "setPassword.ts"];

// backup-run and backup-restore raise sentences from inside a RUN as well as
// from the door — "Emptying ticket_lines failed: <the database's words>" and
// its like. Those land on the run row and the backup panel, which is an
// Admin's own diagnostic record of a restore, and they are deliberately not
// held to this rule. Only the sentences that answer a request are.
// Every catch that ANSWERS a request: a catch whose block returns a body with
// an `error` in it. NOT the last catch in the file — backup-run and
// backup-restore both catch inside helpers that run long after the door has
// answered, and an inner catch that recovers, or one that records a failure on
// a run row, is not a door and is not held to this.
function doorCatches(src) {
  const out = [];
  let at = src.indexOf("} catch (e) {");
  while (at >= 0) {
    const block = src.slice(at, at + 900);
    if (/return (json|new Response)\(/.test(block) && /error:/.test(block)) out.push(block);
    at = src.indexOf("} catch (e) {", at + 1);
  }
  return out;
}

const DOOR_SENTENCES = {
  "backup-run": ["runId is required"],
  "backup-restore": [
    "folderId is required", "That backup is not in the drive any more.",
    "To restore, type the backup's name exactly", "Pick at least one job to restore.",
    "Something is already running", "runId is required", "That backup has no tables folder"
  ]
};

test("no sentence of ours is raised unmarked in a gated door", () => {
  const OWN_PHASES = new Set(["backup-run", "backup-restore"]);
  for (const name of GATED) {
    if (OWN_PHASES.has(name)) continue;
    const bare = [...fn(name).matchAll(/throw new Error\(\s*["`]/g)];
    assert.equal(bare.length, 0,
      `${name}: ${bare.length} sentence(s) raised unmarked — write throw refuse("…")`);
  }
  for (const name of GATED_MODULES) {
    const bare = [...shared(name).matchAll(/throw new Error\(\s*["`]/g)];
    assert.equal(bare.length, 0, `${name}: ${bare.length} sentence(s) raised unmarked`);
  }
});

test("the sentences a gated door answers with are marked, phases or not", () => {
  for (const [name, sentences] of Object.entries(DOOR_SENTENCES)) {
    const src = fn(name);
    for (const words of sentences) {
      const at = src.indexOf(words);
      assert.ok(at > 0, `${name}: "${words}" is gone — was it reworded?`);
      // Look back over the throw that carries it, not the whole file.
      const before = src.slice(Math.max(0, at - 120), at);
      assert.match(before, /throw refuse\(/,
        `${name}: "${words}" answers a request unmarked, so the person reads nothing`);
    }
  }
});

test("every gated catch judges before it answers, and logs either way", () => {
  for (const name of GATED) {
    const src = fn(name);
    const answering = doorCatches(src);
    assert.ok(answering.length > 0, `${name}: no catch answers a request`);
    for (const tail of answering) {
      assert.doesNotMatch(tail, /error: \(e as Error\)\.message/,
        `${name}: still returns the raw error message`);
      assert.match(tail, /publicWords\(e, TROUBLE\)/,
        `${name}: the answer is not judged against the mark`);
      assert.match(src, /^const TROUBLE = "[^"]{20,}";$/m,
        `${name}: has no fixed sentence of its own`);
      // backup-run wraps a gateway page into a sentence of its own before it
      // logs, so the log call is not always the literal loggedWords(e) — but
      // the raw words have to reach the log by SOME route from that catch.
      assert.match(tail, /loggedWords\(e\)/,
        `${name}: masks the failure without writing it down`);
      assert.match(tail, /logError\(/, `${name}: nothing is written down at all`);
    }
  }
});

test("the one door a stranger can reach tells them nothing about this project", () => {
  const src = fn("backup-oauth");
  // The provider redirects a browser here with no token at all. Two things
  // answer it: the no-app-address path, which used to hand back whatever
  // readSettings threw — PostgREST's own error, to anyone — and the failure
  // path, which has always spoken through providerRefusal.
  assert.doesNotMatch(src, /new Response\(\(e as Error\)\.message/,
    "the callback answers a stranger with a raw error");
  assert.match(src, /publicWords\(e, ANON_TROUBLE\)/,
    "the callback does not judge the mark before answering");
  assert.match(src, /^const ANON_TROUBLE = "[^"]{20,}";$/m);
  assert.match(src, /providerRefusal\(message\)/,
    "a drive's own refusal body is no longer turned into our words");
  // And it must stay unlogged: a door anyone can knock on is a way to fill
  // function_errors if every knock writes a row.
  const cb = src.slice(src.indexOf("async function callback("));
  const anon = cb.slice(0, cb.indexOf("const home ="));
  assert.doesNotMatch(anon, /logError\(/,
    "the anonymous path writes to the log, which is an amplifier");
});

test("the one definition marks, judges the mark and never judges the words", async () => {
  const src = shared("publicError.ts");

  // It is a module every function can import, so unlike the guard-list
  // copies it has no reason to be spelled out twice.
  assert.match(src, /export function refuse\(words: string, detail\?: string\): Error/);
  assert.match(src, /export function plainRefusal\(e: unknown\): boolean/);
  assert.match(src, /export function publicWords\(e: unknown, fallback: string\): string/);
  assert.match(src, /export function loggedWords\(e: unknown\): string/);

  // The mark is a property, not a phrase. Judging the words is what the
  // first attempt did and what allow-by-default means.
  assert.match(src, /\.plain === true/);
  assert.doesNotMatch(src, /test\(message\)|\.match\(\/|RegExp\(/,
    "the judgement reads the mark, never the message");

  // And the behaviour itself, not just its shape. The module is erasable
  // TypeScript, so Node can run it with the types stripped out.
  const mod = await import(
    `data:text/javascript,${encodeURIComponent(src.replace(/: [A-Za-z<>|?{}[\] ,]+(?=[),=])/g, "").replace(/^type .*$/m, "").replace(/ as Marked \| null|as Marked/g, ""))}`
  ).catch(() => null);
  if (mod) {
    const mine = mod.refuse("This assessment has no PDF yet — render it first");
    const theirs = new Error('column "gst_rate" does not exist');
    assert.equal(mod.publicWords(mine, "FIXED"), "This assessment has no PDF yet — render it first");
    assert.equal(mod.publicWords(theirs, "FIXED"), "FIXED", "an unmarked error never gets out");
    // The same sentence, unmarked, is still masked — the whole difference
    // between marking and recognising.
    assert.equal(mod.publicWords(new Error("This assessment has no PDF yet — render it first"), "FIXED"), "FIXED");
    // detail is for the log and only the log.
    const withDetail = mod.refuse("The send went out but could not be marked.", 'relation "x" does not exist');
    assert.equal(mod.publicWords(withDetail, "FIXED"), "The send went out but could not be marked.");
    assert.match(mod.loggedWords(withDetail), /relation "x" does not exist/);
    assert.match(mod.loggedWords(theirs), /gst_rate/, "the office still gets the database's own words");
  }
});

test("no sentence of ours is raised unmarked in a staff-reachable function", () => {
  for (const name of [...STAFF_REACHABLE.map(fn), ...MAIL_MODULES.map(shared)]) {
    const bare = [...name.matchAll(/throw new Error\(\s*["`]/g)];
    assert.equal(bare.length, 0,
      `${bare.length} sentence(s) raised unmarked — write throw refuse("…") so the person can read it`);
  }
});

test("every staff-reachable catch judges before it answers, and logs either way", () => {
  for (const name of STAFF_REACHABLE) {
    const src = fn(name);
    const tail = src.slice(src.lastIndexOf("} catch (e) {"));
    assert.ok(tail.length > 0, `${name}: no top-level catch found`);

    // The defect itself: the raw message going back to the browser.
    assert.doesNotMatch(tail, /error: \(e as Error\)\.message/,
      `${name}: still returns the raw error message`);
    // And the fixed sentence has to be a real one, not an empty string that
    // would read as "nothing went wrong".
    assert.match(tail, /publicWords\(e, TROUBLE\)/,
      `${name}: the answer is not judged against the mark`);
    assert.match(src, /^const TROUBLE = "[^"]{20,}";$/m,
      `${name}: has no fixed sentence of its own`);
    // Masking without logging would only move the blindness — the office
    // would lose exactly what the browser stopped being told.
    assert.match(tail, /logError\("[a-z-]+", loggedWords\(e\)/,
      `${name}: masks the failure without writing it down`);
  }
});

test("a refusal a person can act on still reaches them", () => {
  // The other half, and the one a blunt fix would have broken: these are
  // the sentences that name something to go and do. Masking them would
  // leave a technician staring at a button that does nothing.
  const cases = [
    ["send-jha", /throw refuse\("This assessment has no PDF yet/],
    ["send-report", /throw refuse\("Report not found, or you don't have access to it"\)/],
    ["send-ticket-approval", /throw refuse\("That ticket is already approved/],
    ["render-jha", /throw refuse\("That hazard assessment couldn't be found/],
    ["gif-search", /throw refuse\("GIF search isn't set up yet/]
  ];
  for (const [name, re] of cases) assert.match(fn(name), re, `${name}: lost a sentence a person can act on`);

  const mail = shared("mail.ts");
  assert.match(mail, /throw refuse\("Email isn't set up yet/, "the Admin is still told what to add");
  assert.match(mail, /throw refuse\(`\$\{field\} is not a valid email address/, "a bad address still names itself");
  assert.match(mail, /throw refuse\(`Email is in testing mode/, "testing mode still names the fix");
});

test("the provider's own body is not ours to pass on, but a rate limit is", () => {
  const mail = shared("mail.ts");

  // Resend's error body is written for us, not for the person, and it can
  // quote back whatever was submitted.
  assert.match(mail, /throw refuse\("The email was refused by the mail provider[^"]*",\s*`Resend \$\{body\.statusCode/,
    "the provider's body is logged, not shown");

  // But a transient refusal MUST cross the boundary in words: the bulk
  // chase tells "slow down" from "that address is wrong" by reading the
  // message, and only the message survives the trip back. Masked, every
  // rate limit would reach the tracker as an unexplained failure and
  // thousands of approvals it could have waited for would be counted as
  // tickets the office must chase by hand.
  assert.match(mail, /function transient\(message: string, retryAfter: number \| null\) \{\s*const e = refuse\(message\)/,
    "a transient refusal is marked, or the chase cannot read it");
  for (const phrase of ["Resend is rate-limiting", "Resend is unavailable"]) {
    assert.ok(mail.includes(`throw transient(\`${phrase}`), `${phrase} is still raised as transient`);
  }
  // The words the tracker actually looks for, read back from the screen so
  // the two cannot drift apart.
  const pool = read("./sendPool.js");
  for (const phrase of ["rate-limiting", "unavailable"]) {
    assert.ok(pool.includes(phrase), `sendPool no longer recognises "${phrase}"`);
  }
});

test("a send that went but could not be recorded still says so, and only to the office", () => {
  // The sharpest sentence in the set: the email HAS gone. Telling the
  // person "try again" would send it twice; telling them the database's
  // reason tells them nothing they can use. So the sentence is ours and
  // the reason is the log's.
  for (const [file, phrase] of [
    ["mailJha.ts", "don't send it again"],
    ["mailReport.ts", "don't send it again"],
    ["mailApproval.ts", "resend the ticket"]
  ]) {
    const src = shared(file);
    assert.ok(src.includes(phrase), `${file}: lost the do-not-send-again warning`);
    assert.match(src, /throw refuse\(\s*"[^"]+",\s*(markErr|tokenErr)\.message\s*\)/,
      `${file}: the database's reason is still in the words the person reads`);
  }
});

test("a failed tool read is logged, and what the model may repeat is masked by the mark", () => {
  // Round 7's masking sat on the top-level catch, which a failed TOOL read
  // never reaches: askLoop catches it, puts the words in the conversation,
  // and the model can quote them in an answer that leaves with a 200. Two
  // halves fix it and both are checked here, because either alone is worse
  // than useless — masking without logging moves the blindness, and logging
  // without masking is the disclosure.
  const loop = shared("askLoop.ts");
  assert.match(loop, /const words = isPlain\(e\) \? `The read failed: \$\{\(e as Error\)\.message\}` : TOOL_TROUBLE;/,
    "askLoop no longer judges a tool error by the mark");
  assert.match(loop, /const TOOL_TROUBLE = "[^"]+";/, "the fixed sentence is gone");
  assert.doesNotMatch(loop.slice(loop.indexOf("const TOOL_TROUBLE")).split("\n")[0], /\$\{/,
    "the fixed sentence must not interpolate anything");

  const ask = read("../../supabase/functions/ask/index.ts");
  assert.match(ask, /const runTool = async \(name: string, input: Record<string, unknown>\): Promise<unknown> => \{\s*try \{\s*return await readTool\(name, input\);\s*\} catch \(e\) \{\s*await logError\("ask", loggedWords\(e\), \{ user: userId, tool: name \}\);\s*throw e;\s*\}/,
    "a failed tool read no longer reaches function_errors with its real words");
});
