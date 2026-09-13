// The one thing the isolated PostgreSQL harness cannot answer.
//
// probes-ticket-money-select.mjs proves the grants and the masking in a
// throwaway database. It says nothing about PostgREST, and PostgREST is
// where this change can still break: `tickets_read` is a view, and two
// reads in the app embed `ticket_lines` through it -- getTicket, which
// reopens a draft in the billing screen, and listTicketsForArchive, which
// prints Job details.txt. A forward embed (jobs, profiles) follows a
// foreign key the view's own column carries; a REVERSE embed has to match
// ticket_lines.ticket_id back to a view column PostgREST worked out is
// really tickets.id. It does do that, and has since PostgREST 7 -- but
// "does" is a thing to see answer 200 on the deployed API, not a thing to
// assume on the night the base-table grant is taken away. If this refuses,
// the invoice viewer and reopening a draft both break, and the fix is to
// read the lines in a second request rather than to press on.
//
// Run it AFTER ticket-money-select.sql is applied and the readers are
// deployed, and BEFORE ticket-money-select-enforce.sql. Run it again after.
// It only reads.
//
//   node supabase/handover/probes-ticket-money-select-api.mjs \
//     --url https://eielmvxzdwwprmmfamlq.supabase.co --key <publishable key> \
//     --priced admin@example.com:<password> --helper helper@example.com:<password>
//
// A password on the command line lands in the shell's history and in the
// process list, so every one of those four may come from the environment
// instead, which is the way to prefer:
//
//   PROBE_URL, PROBE_KEY, PROBE_PRICED, PROBE_HELPER
//
// each holding what the matching flag would hold (the two accounts as
// `email:password`). A flag wins over the variable when both are there.
//
// The two accounts are a price role (Admin or Technician) and one without
// (Helper or Coordinator). Both halves matter: the first proves the embeds
// still resolve and the money still arrives, the second proves the money
// does not.

const arg = name => {
  const i = process.argv.indexOf(`--${name}`);
  const flag = i === -1 ? null : process.argv[i + 1];
  // A flag wins; the environment is the way that keeps a password out of
  // the shell's history and out of the process list.
  return flag || process.env[`PROBE_${name.toUpperCase()}`] || null;
};
const url = arg("url"), key = arg("key");
if (!url || !key) {
  console.error("Need --url and --key (or PROBE_URL and PROBE_KEY). See the header of this file.");
  process.exit(2);
}
const account = flag => {
  const raw = arg(flag);
  if (!raw) return null;
  const at = raw.indexOf(":");
  if (at < 1 || at === raw.length - 1) {
    console.error(`--${flag} wants email:password.`);
    process.exit(2);
  }
  return { email: raw.slice(0, at), password: raw.slice(at + 1) };
};

let failures = 0, checks = 0;
const ok = (name, pass, detail = "") => {
  checks++;
  if (!pass) failures++;
  console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
};

async function signIn(who) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify(who)
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`sign-in failed for ${who.email}: ${body.error_description || body.msg || res.status}`);
  return body.access_token;
}

// PostgREST speaks for itself: the status and the body are the whole answer.
async function read(token, path) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` }
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* PostgREST answers HTML on a gateway blink */ }
  return { status: res.status, body, text: text.slice(0, 200) };
}

const LINES = "ticket_lines(kind,label,unit,quantity,unit_rate)";

async function priced(token) {
  console.log("\nPrice role (Admin or Technician)");

  // The reverse embed, ordered the way the invoice prints. This is the read
  // the whole probe exists for.
  const invoice = await read(token,
    `tickets_read?select=id,total,${LINES}&ticket_lines.order=line_order.asc&limit=1`);
  ok("tickets_read embeds ticket_lines (reverse, ordered)", invoice.status === 200, `${invoice.status} ${invoice.text}`);
  const row = Array.isArray(invoice.body) ? invoice.body[0] : null;
  if (row) {
    ok("the embed comes back as an array", Array.isArray(row.ticket_lines), JSON.stringify(row.ticket_lines ?? null).slice(0, 80));
    ok("a price role still reads the total", row.total !== null || Number(row.total) === 0, String(row.total));
  } else {
    ok("at least one ticket to read", false, "no rows -- run this against a project that has tickets");
  }

  // The forward embeds the job screens and the tracker use.
  const forward = await read(token,
    "tickets_read?select=id,total,profiles(name),jobs(job_number,project,clients(name))&limit=1");
  ok("tickets_read embeds profiles, jobs and clients (forward)", forward.status === 200, `${forward.status} ${forward.text}`);

  // The archive's batched read, which is the reverse embed again with an
  // `in` filter and the line_order column it sorts on in the browser.
  const archive = await read(token,
    `tickets_read?select=id,total,profiles(name),ticket_lines(kind,label,unit,quantity,unit_rate,line_order)&limit=1`);
  ok("the archive's ticket shape resolves", archive.status === 200, `${archive.status} ${archive.text}`);

  // Not an assertion, a reading: which phase this project is in.
  const base = await read(token, "tickets?select=total&limit=1");
  console.log(base.status === 200
    ? "  note  direct tickets.total still readable -- phase 1. The disclosure is still open."
    : `  note  direct tickets.total refused (${base.status}) -- phase 2 is applied.`);
  return base.status === 200;
}

async function unpriced(token, enforced) {
  console.log("\nNo price role (Helper or Coordinator)");
  const masked = await read(token, "tickets_read?select=id,total&limit=1");
  ok("tickets_read answers", masked.status === 200, `${masked.status} ${masked.text}`);
  const row = Array.isArray(masked.body) ? masked.body[0] : null;
  ok("the total is masked to null", row ? row.total === null : false, row ? String(row.total) : "no rows");

  // Metadata this account legitimately reads is untouched either way.
  const meta = await read(token, "tickets?select=id,status,work_date&limit=1");
  ok("ticket metadata still readable from the base table", meta.status === 200, `${meta.status} ${meta.text}`);

  const total = await read(token, "tickets?select=total&limit=1");
  const star = await read(token, "tickets?select=*&limit=1");
  const token_ = await read(token, "tickets?select=approval_token&limit=1");
  if (enforced) {
    ok("direct tickets.total refused", total.status >= 400, `${total.status} ${total.text}`);
    ok("select=* refused", star.status >= 400, `${star.status} ${star.text}`);
    ok("approval_token refused", token_.status >= 400, `${token_.status} ${token_.text}`);
  } else {
    console.log(`  note  phase 1: total ${total.status}, select=* ${star.status}, approval_token ${token_.status} -- all expected to answer until enforcement.`);
  }
}

try {
  const a = account("priced"), b = account("helper");
  if (!a) throw new Error("Need --priced email:password.");
  const enforcedLater = !(await priced(await signIn(a)));
  if (b) await unpriced(await signIn(b), enforcedLater);
  else console.log("\n  note  no --helper account given; the masking half was not checked.");
  console.log(`\n${failures ? "FAILED" : "PASS"}: ${checks - failures}/${checks} deployed-API checks.`);
  process.exit(failures ? 1 : 0);
} catch (e) {
  console.error(`\nCould not run: ${e.message}`);
  process.exit(2);
}
