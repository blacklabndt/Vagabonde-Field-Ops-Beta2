import React, { useState, useEffect } from "react";
import { Db } from "../db.js";
import { Blueprint, Btn, Field, ErrorBox, Loading, TagX } from "./common.jsx";
import { ArchiveDialog } from "./archiveDialog.jsx";
import { AutomaticBackupPanel } from "./backupPanel.jsx";

// Admin — every key and address the app needs to be fully alive, in one
// screen, each with the instructions for getting it. The software ships to
// a client whose admin will never run a CLI: what used to be Supabase
// secrets is now this screen writing the app_settings row, with the env
// secrets left as silent fallback for anything a column leaves blank.
//
// The sections are ordered by how much the crew feels their absence:
// email first (reports and billing approvals), then the approval-link
// address, then chat GIFs. Push notifications close it out read-only —
// their keys are baked into the app at build time and are not a thing an
// admin obtains from a vendor.

const SECTION_TITLE = { fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 16, marginBottom: 4 };
const SECTION_HELP = { fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginBottom: 12, lineHeight: 1.5 };

export function AdminSetupScreen({ currentUser, onArchiveCleared }) {
  // The Archive dropdown: "year" or "range" opens the dialog.
  const [archiveMode, setArchiveMode] = useState(null);
  const [form, setForm] = useState({
    resendApiKey: "", fromReports: "", fromBilling: "", replyTo: "",
    klipyApiKey: "", anthropicApiKey: "", askDailyTokenCap: "", approvalBaseUrl: "",
    invoiceTerms: "", invoiceRemitTo: "", businessNumber: ""
  });
  // "loading" | "ready" | "failed". Failed matters: saving writes the whole
  // form over the whole row, so a save on top of a load that never arrived
  // would null out every stored key. Save only unlocks once the row has
  // genuinely been read.
  const [loadState, setLoadState] = useState("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const load = () => {
    setLoadState("loading");
    setError("");
    let live = true;
    Db.getAppSettings()
      .then(row => {
        if (!live) return;
        setForm({
          resendApiKey: row.resend_api_key || "",
          fromReports: row.from_reports || "",
          fromBilling: row.from_billing || "",
          replyTo: row.reply_to || "",
          klipyApiKey: row.klipy_api_key || "",
          anthropicApiKey: row.anthropic_api_key || "",
          // Blank means no limit, and an empty box has to mean exactly that —
          // so a null stays blank rather than becoming "0", which the save
          // would then refuse on a form the Admin never touched.
          askDailyTokenCap: row.ask_daily_token_cap == null ? "" : String(row.ask_daily_token_cap),
          approvalBaseUrl: row.approval_base_url || "",
          invoiceTerms: row.invoice_terms || "",
          invoiceRemitTo: row.invoice_remit_to || "",
          businessNumber: row.business_number || ""
        });
        setLoadState("ready");
      })
      .catch(e => {
        if (!live) return;
        setError((e.message || "Couldn't load the settings.") + " Nothing can be saved until they load.");
        setLoadState("failed");
      });
    return () => { live = false; };
  };
  useEffect(load, []);

  const set = (key, value) => { setForm(p => ({ ...p, [key]: value })); setError(""); };

  const save = async () => {
    setSaving(true);
    setError("");
    try { await Db.saveAppSettings(form); }
    catch (e) { setError(e.message || "Couldn't save the settings."); }
    finally { setSaving(false); }
  };

  const sendTest = async () => {
    setTesting(true);
    setError("");
    setTestResult(null);
    try { setTestResult(await Db.sendTestEmail(testTo)); }
    catch (e) { setError(e.message || "The test send failed."); }
    finally { setTesting(false); }
  };

  // Either sending address blank means some mail still goes out under the
  // test sender — approvals ride the billing address, reports the other.
  const emailTestingMode = !form.fromReports.trim() || !form.fromBilling.trim();

  if (loadState === "loading") return <div className="page"><Loading label="Loading settings…" /></div>;

  return (
    <div className="page">
      <div style={{ marginBottom: 6 }}>
        <h2 style={{ fontSize: 34, margin: 0 }}>Admin</h2>
      </div>
      <p style={{ maxWidth: 760, marginTop: 0, fontSize: 14, color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>
        Set up email, invoice details and backups for your business.
        Only Admins can change these settings. Save your changes to apply them.
      </p>

      <ErrorBox>{error}</ErrorBox>

      {/* The sections flow into as many columns as the page allows — two on
          a desktop, one on a phone — so the screen is not a 640px strip down
          the middle of a wide monitor. Columns rather than a grid: a grid
          makes every row as tall as its tallest card, so a short card left
          a hole beneath it; in a column each card sits 16px under the one
          above, whatever its neighbour's height (.admin-columns in
          app.css). minWidth 0 on each card lets a long, unbroken error
          message wrap inside it instead of widening the column. */}
      <div className="admin-columns">

        {/* Year-end. It lives here, not on Home, because its last step is
            the one bulk delete in the app: the archive dialog only offers
            the clear once the downloaded zip has been checked file by
            file, and then only behind a typed word. */}
        <Blueprint style={{ padding: "18px 20px", borderColor: "var(--color-accent-700)", minWidth: 0 }}>
          <div style={SECTION_TITLE}>Archive</div>
          <div style={SECTION_HELP}>
            Download jobs from a year or date range in one ZIP file, organised by client, month and job.
            It includes job details, hazard assessments, reports and invoices. Downloading does not delete anything.
            If you also want to remove those jobs from the app, you must first let the app check the downloaded
            file, then type the confirmation word shown.
          </div>
          <select className="input" aria-label="Archive" value="" style={{ width: "auto", minHeight: 40 }}
            onChange={e => { if (e.target.value) setArchiveMode(e.target.value); }}>
            <option value="">Archive…</option>
            <option value="year">Archive a year</option>
            <option value="range">Archive a date range</option>
          </select>

          {/* The other half of the same question: the year-end zip is a copy
              taken by hand, this is one taken on a schedule to a drive of
              the owner's own. */}
          <AutomaticBackupPanel />
        </Blueprint>

        <Blueprint style={{ padding: "18px 20px", minWidth: 0 }}>
          <div style={SECTION_TITLE}>Email — reports &amp; billing approvals</div>
          <div style={SECTION_HELP}>
            Sent through <a href="https://resend.com" target="_blank" rel="noreferrer">Resend</a>.
            Create an account, then choose <strong>API Keys → Create API Key</strong> with sending access.
            An API key is the connection code that lets this app use your email account. Paste it below.
            You can then test sending to the inbox you used to sign up for Resend.
            To send to clients, choose <strong>Domains → Add Domain</strong> in Resend and follow its
            instructions to verify your business&rsquo;s email domain (the part after @).
            Your website or email administrator can help with this step. Once verified, enter the two
            sending addresses below. Use your business domain, not a personal Gmail or Hotmail address.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="Resend API key">
              <input className="input" type="password" value={form.resendApiKey}
                onChange={e => set("resendApiKey", e.target.value)}
                placeholder="re_…" autoComplete="off" style={{ width: "100%" }} />
            </Field>
            <Field label="Reports come from">
              <input className="input" value={form.fromReports}
                onChange={e => set("fromReports", e.target.value)}
                placeholder="reports@your-company-domain.ca — leave blank until the domain is verified; never a gmail/hotmail address"
                style={{ width: "100%" }} />
            </Field>
            <Field label="Billing comes from">
              <input className="input" value={form.fromBilling}
                onChange={e => set("fromBilling", e.target.value)}
                placeholder="billing@your-company-domain.ca — leave blank until the domain is verified; never a gmail/hotmail address"
                style={{ width: "100%" }} />
            </Field>
            <Field label="Replies go to">
              <input className="input" value={form.replyTo}
                onChange={e => set("replyTo", e.target.value)}
                placeholder="a real mailbox someone reads, so a contractor can just hit reply"
                style={{ width: "100%" }} />
            </Field>
            {emailTestingMode && form.resendApiKey.trim() && (
              <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
                No sending address yet, so everything — test emails and real report or approval
                sends alike — goes out from Resend&rsquo;s onboarding sender and can only reach the
                inbox of the address the Resend account was created with. Right for trying the
                whole flow on yourself, not for clients.
              </div>
            )}
          </div>
        </Blueprint>

        <Blueprint style={{ padding: "18px 20px", minWidth: 0 }}>
          <div style={SECTION_TITLE}>Client approval links</div>
          <div style={SECTION_HELP}>
            Clients use a link in their approval email to review and sign a ticket.
            Enter this app&rsquo;s web address below, using the example shown beneath the box.
            An app address must be configured before approval emails can be sent.
          </div>
          <Field label="App address">
            <input className="input" value={form.approvalBaseUrl}
              onChange={e => set("approvalBaseUrl", e.target.value)}
              placeholder={window.location.origin}
              style={{ width: "100%" }} />
          </Field>
          <div style={{ fontSize: 12, marginTop: 8, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
            You&rsquo;re reading the app at <span className="tabular">{window.location.origin}</span> right
            now — that&rsquo;s almost always the value to put here.
          </div>
        </Blueprint>

        {/* The words on the bill. They sit beside the approval address
            because they finish the same document: the address decides where
            the client signs it, these decide whether their accounts
            department can pay it without it being re-typed elsewhere. */}
        <Blueprint style={{ padding: "18px 20px", minWidth: 0 }}>
          <div style={SECTION_TITLE}>Invoices</div>
          <div style={SECTION_HELP}>
            Add the payment details clients should see on each invoice. Leave a field blank to omit it.
            The app assigns an invoice number when you mark a ticket invoiced in the billing tracker.
            If you undo that step and invoice the ticket again, it keeps the same number.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="Payment terms">
              <input className="input" value={form.invoiceTerms}
                onChange={e => set("invoiceTerms", e.target.value)}
                placeholder="Net 30 days — printed under the total"
                style={{ width: "100%" }} />
            </Field>
            <Field label="GST number">
              <input className="input" value={form.businessNumber}
                onChange={e => set("businessNumber", e.target.value)}
                placeholder="123456789 RT0001 — printed under the company name"
                style={{ width: "100%" }} />
            </Field>
            <Field label="Payment instructions">
              <textarea className="input" rows={4} value={form.invoiceRemitTo}
                onChange={e => set("invoiceRemitTo", e.target.value)}
                placeholder={"Where the money goes — printed under the total, line breaks kept.\nVagaboNDE Inc.\nPO Box 000, Grande Prairie, AB"}
                style={{ width: "100%" }} />
            </Field>
          </div>
        </Blueprint>

        <Blueprint style={{ padding: "18px 20px", minWidth: 0 }}>
          <div style={SECTION_TITLE}>Chat GIFs and Ask assistant</div>
          <div style={SECTION_HELP}>
            The chat&rsquo;s GIF picker searches <a href="https://klipy.com" target="_blank" rel="noreferrer">KLIPY</a>.
            To enable GIF search, create an account and an app on KLIPY, then paste the API key
            (connection code) it gives you below. This is optional; chat messages work without it.
          </div>
          <Field label="KLIPY API key">
            <input className="input" type="password" value={form.klipyApiKey}
              onChange={e => set("klipyApiKey", e.target.value)}
              placeholder="from klipy.com — optional" autoComplete="off" style={{ width: "100%" }} />
          </Field>
          <p className="body-s" style={{ marginTop: 14 }}>
            Ask &mdash; the button at the bottom right of every screen &mdash; answers questions
            with Claude, through <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">Anthropic</a>.
            Paste an Anthropic API key (connection code) below to enable Ask.
            Anthropic charges your account for its use.
          </p>
          <Field label="Anthropic API key">
            <input className="input" type="password" value={form.anthropicApiKey}
              onChange={e => set("anthropicApiKey", e.target.value)}
              placeholder="from console.anthropic.com — optional" autoComplete="off" style={{ width: "100%" }} />
          </Field>
          {/* The stop on a runaway. Ask refuses to spend past this for the
              rest of the day and says so, in words that send the person
              here — so this box has to exist, or that sentence is a lie. */}
          <p className="body-s" style={{ marginTop: 14 }}>
            Daily spending limit. Anthropic bills by <em>tokens</em> — roughly a word each, counted
            both ways: the question and everything Ask reads to answer it, plus the answer itself.
            A typical question costs a few thousand. The limit below covers the whole crew for one
            day, and Ask stops until the next morning once it is reached. Leave it blank for no
            limit. Check the running cost in your Anthropic account.
          </p>
          <Field label="Daily limit (tokens)">
            <input className="input" inputMode="numeric" value={form.askDailyTokenCap}
              onChange={e => set("askDailyTokenCap", e.target.value)}
              placeholder="10000000 — blank for no limit" autoComplete="off" style={{ width: "100%" }} />
          </Field>
        </Blueprint>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {loadState === "failed" && <Btn variant="secondary" onClick={load}>Try loading again</Btn>}
          <Btn variant="primary" disabled={saving || loadState !== "ready"} onClick={save}>{saving ? "Saving…" : "Save settings"}</Btn>
        </div>

        <Blueprint style={{ padding: "18px 20px", minWidth: 0 }}>
          <div style={SECTION_TITLE}>Send a test email</div>
          <div style={SECTION_HELP}>
            Save your settings, then send a test to an inbox you can check.
            Confirm it arrives before using the app to email clients.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input className="input" value={testTo} onChange={e => setTestTo(e.target.value)}
              placeholder="you@example.com" style={{ flex: "1 1 240px", minWidth: 200 }} />
            <Btn variant="secondary" disabled={testing || !testTo.trim()} onClick={sendTest}>
              {testing ? "Sending…" : "Send test email"}
            </Btn>
          </div>
          {testResult && (
            <div style={{ fontSize: 13, marginTop: 10, color: "var(--color-accent)" }}>
              Sent, from {testResult.from}. {String(testResult.from).includes("resend.dev")
                ? "That's the test sender — it only reaches the Resend account owner's inbox until the domain is verified."
                : "Check the inbox (and spam, the first time)."}
            </div>
          )}
        </Blueprint>

        <Blueprint style={{ padding: "18px 20px", minWidth: 0 }}>
          <div style={SECTION_TITLE}>Push notifications — nothing to do here</div>
          <div style={{ ...SECTION_HELP, marginBottom: 0 }}>
            Chat notifications are already configured: their signing keys are built into the app
            itself and the matching secret lives on the server, set up when the app was deployed.
            There&rsquo;s no vendor account and no key to paste — each person just allows
            notifications on their own device from Team chat. If they ever need to change, that&rsquo;s
            a developer task (new keys mean every device re-allows notifications), not a setting here.
          </div>
        </Blueprint>

        <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
          Two settings live outside the app, in the Supabase dashboard, because they guard sign-in
          itself: the <strong>Site URL</strong> (Authentication → URL Configuration — where
          password-reset links land) and <strong>leaked-password protection</strong> (Authentication →
          Policies). The setup document covers both.
        </div>

        <RecentErrorsPanel />
        <LearnedPanel />
      </div>

      {/* onCleared is passed straight through: the jobs the clear removes may
          be open elsewhere in the app — a job screen, a ticket, the drafts
          badge — and only App holds any of that. */}
      {archiveMode && (
        <ArchiveDialog mode={archiveMode} currentUser={currentUser} onClose={() => setArchiveMode(null)}
          onCleared={onArchiveCleared} />
      )}
    </div>
  );
}

// What the Edge Functions log when they fail — report emails, approvals, PDF
// renders, account removals — that nobody would otherwise hear about until
// a client or a tech complained. Admin-only, like the rest of this screen.
// (It sat on Users & access; the owner asked for it here.)
// What Ask has learned from the crew about the app — kept on its own after
// conversations, one memory for everyone, so the office can read it and
// prune a wrong note. This list is the oversight the no-confirm learning
// rests on: an Admin may delete any note; the speaker their own.
function LearnedPanel() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const load = async () => {
    setErr("");
    try { setRows(await Db.listLearned()); }
    catch (e) { setRows([]); setErr(e.message || "Couldn't read what Ask has learned."); }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once at mount; load is a per-render function over the same Db
  useEffect(() => { load(); }, []);
  const forget = async id => {
    setBusy(id);
    setErr("");
    try { await Db.forgetLearned(id); setRows(r => (r || []).filter(x => x.id !== id)); }
    catch (e) { setErr(e.message || "Couldn't delete that note."); }
    finally { setBusy(""); }
  };
  const when = iso => { try { return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric" }); } catch { return ""; } };
  return (
    <Blueprint style={{ padding: "18px 20px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
        <div style={{ ...SECTION_TITLE, marginBottom: 0 }}>What Ask has learned</div>
        <span style={{ marginLeft: "auto" }}>
          <Btn variant="secondary" onClick={load} disabled={rows === null}>{rows === null ? "Loading…" : "Refresh"}</Btn>
        </span>
      </div>
      <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 14 }}>
        Things the crew has told Ask about how the app works, kept on its own after conversations and used in every answer.
        A note from an Admin is treated as fact; one from anyone else as something a crew member said. Delete anything wrong.
      </div>
      <ErrorBox>{err}</ErrorBox>
      {rows && !rows.length && !err && (
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Nothing learned yet.</div>
      )}
      {rows && rows.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map(r => (
            <div key={r.id} style={{ border: "1px solid var(--color-neutral-300)", padding: "10px 12px", fontSize: 13, display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div>{r.note}</div>
                <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: 4 }}>
                  {r.profiles ? `${r.profiles.name || "(no name)"} · ${r.profiles.role || ""}` : "(account removed)"} · {when(r.created_at)}
                </div>
              </div>
              <Btn variant="secondary" disabled={busy === r.id} onClick={() => forget(r.id)}>{busy === r.id ? "Working…" : "Delete"}</Btn>
            </div>
          ))}
        </div>
      )}
    </Blueprint>
  );
}

function RecentErrorsPanel() {
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [clearing, setClearing] = useState(false);
  // One function's errors, or all of them; the names come from the log
  // itself. `more` is true while the last page came back full, so the
  // button disappears exactly when there is nothing older to show.
  const [names, setNames] = useState([]);
  const [fn, setFn] = useState("");
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const PAGE = 20;

  // The dropdown's names are read with the first page and on Refresh —
  // filtering by one of them cannot change the list, and that read walks
  // the whole log.
  // A request token, like every other filtered list in the app: switching
  // function while a read is in flight used to paint one function's errors
  // under another function's name.
  const loadSeq = React.useRef(0);
  const load = (functionName = fn, withNames = false) => {
    const mine = ++loadSeq.current;
    setLoading(true);
    // The reason the last read failed is not the reason for this one, and
    // leaving it up made every later Refresh look like it had failed too.
    setErr("");
    Promise.all([Db.listFunctionErrors(PAGE, { functionName }), withNames ? Db.listFunctionErrorNames().catch(() => null) : null])
      .then(([rows, seen]) => { if (mine !== loadSeq.current) return; setErrors(rows); setMore(rows.length === PAGE); if (seen) setNames(seen); })
      .catch(e => { if (mine === loadSeq.current) setErr(e.message || "Couldn't load recent errors."); })
      .finally(() => { if (mine === loadSeq.current) setLoading(false); });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first page is read once at mount; the filter and Refresh call load themselves
  useEffect(() => { load(fn, true); }, []);

  const loadMore = async () => {
    const last = errors[errors.length - 1];
    if (!last) return;
    // The next page takes the token too: switching function mid-read used to
    // append one function's older errors to another function's list.
    const mine = ++loadSeq.current;
    setLoadingMore(true);
    setErr("");
    try {
      const rows = await Db.listFunctionErrors(PAGE, { before: last, functionName: fn });
      if (mine !== loadSeq.current) return;
      setErrors(p => p.concat(rows));
      setMore(rows.length === PAGE);
    } catch (e) {
      if (mine === loadSeq.current) setErr(e.message || "Couldn't load older errors.");
    } finally {
      setLoadingMore(false);
    }
  };

  // The whole log, not the twenty on screen: the list shows the newest
  // twenty, and clearing only those would leave older rows to surface as
  // "recent" the moment it was pressed.
  const clear = async () => {
    if (!window.confirm("Clear every logged background error? They cannot be brought back.")) return;
    setClearing(true);
    setErr("");
    try {
      await Db.clearFunctionErrors();
      setErrors([]);
    } catch (e) {
      setErr(e.message || "Couldn't clear the log.");
    } finally {
      setClearing(false);
    }
  };

  return (
    <Blueprint style={{ padding: "18px 20px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
        <div style={{ ...SECTION_TITLE, marginBottom: 0 }}>Recent background errors</div>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {names.length > 1 && (
            <select className="input" aria-label="Which task" value={fn}
              style={{ width: "auto", minHeight: 34, padding: "4px 8px", fontSize: 13 }}
              onChange={e => { setFn(e.target.value); load(e.target.value); }}>
              <option value="">All tasks</option>
              {names.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          <Btn variant="secondary" onClick={() => load(fn, true)} disabled={loading || clearing}>{loading ? "Loading…" : "Refresh"}</Btn>
          <Btn variant="danger" onClick={clear} disabled={loading || clearing || !errors.length}>{clearing ? "Clearing…" : "Clear"}</Btn>
        </span>
      </div>
      <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 14 }}>
        Tasks the app could not finish, such as sending emails, creating PDFs or removing accounts.
        The details below can help the person supporting your app investigate. Clearing this list does not fix the cause.
      </div>
      <ErrorBox>{err}</ErrorBox>
      {!loading && !errors.length && !err && (
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>No errors recorded.</div>
      )}
      {errors.length > 0 && (
        <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginBottom: 8 }}>
          Showing the newest {errors.length}{fn ? ` from ${fn}` : ""}{more ? " — there are older ones" : " — that is all of them"}.
        </div>
      )}
      {errors.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          {errors.map(e => (
            <div key={e.id} style={{ border: "1px solid var(--color-neutral-300)", padding: "10px 12px", fontSize: 13 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <TagX variant="outline">{e.function_name}</TagX>
                <span style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginLeft: "auto" }}>
                  {/* With the year left off, an error from last September
                      read exactly like one from this morning — which is the
                      one thing this line has to settle after a quiet spell,
                      when the newest twenty are all old. */}
                  {new Date(e.created_at).toLocaleString("en-CA", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
              <div style={{ marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{e.message}</div>
            </div>
          ))}
        </div>
      )}
      {more && !loading && (
        <div style={{ marginTop: 10 }}>
          <Btn variant="secondary" onClick={loadMore} disabled={loadingMore || clearing}>{loadingMore ? "Loading…" : "Load 20 more"}</Btn>
        </div>
      )}
    </Blueprint>
  );
}
