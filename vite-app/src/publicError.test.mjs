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
// searches. The Admin-gated and internal-secret functions are a separate
// commit: their callers are already Admins or hold the internal secret.
const STAFF_REACHABLE = [
  "send-jha", "send-report", "send-ticket-approval",
  "render-invoice", "render-jha", "gif-search", "feature-request"
];

// The modules those doors throw from. A sentence raised here reaches the
// person through one of the catches above, so it is held to the same rule.
const MAIL_MODULES = ["mail.ts", "mailJha.ts", "mailReport.ts", "mailApproval.ts"];

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
