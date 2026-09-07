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
    klipyApiKey: "", approvalBaseUrl: "",
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
        The keys and addresses the app needs to be fully working, and where each one comes from.
        Everything here is Admin-only; save applies immediately, no restart needed.
      </p>

      {/* The sections flow into as many columns as the page allows — two on
          a desktop, one on a phone — so the screen is not a 640px strip down
          the middle of a wide monitor. min(…, 100%) keeps a card narrower
          than a phone from forcing the page to scroll sideways, and minWidth
          0 on each card lets a long, unbroken error message wrap inside it
          instead of widening the grid. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(460px, 100%), 1fr))", gap: 16, alignItems: "start" }}>
        <div style={{ gridColumn: "1 / -1" }}><ErrorBox>{error}</ErrorBox></div>

        {/* Year-end. It lives here, not on Home, because its last step is
            the one bulk delete in the app: the archive dialog only offers
            the clear once the downloaded zip has been checked file by
            file, and then only behind a typed word. */}
        <Blueprint style={{ padding: "18px 20px", borderColor: "var(--color-accent-700)", minWidth: 0 }}>
          <div style={SECTION_TITLE}>Archive</div>
          <div style={SECTION_HELP}>
            Every job raised in a year or a date range, as one zip filed client → month → job: the job's details
            as a text file, its hazard assessments and reports as the PDFs on file, and each ticket's field invoice.
            Building changes nothing. Once the zip on this computer has been checked against what was built, the
            dialog offers to clear those jobs from the app to start fresh — the only bulk delete there is, so it is
            kept off Home and behind a typed confirmation.
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
            Create a free account (3,000 emails/month), then <strong>API Keys → Create API Key</strong> with
            sending access, and paste it here — that alone sends test emails to the Resend account&rsquo;s
            own inbox, today. To email clients for real: <strong>Domains → Add Domain</strong>, add the DNS
            records Resend shows you at your domain host, wait for it to verify, then fill in the two
            sending addresses below — they must be on that verified domain (a personal
            gmail/hotmail address can never send, and filling these too early turns off
            the testing mode that can).
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
          <div style={SECTION_TITLE}>Approval links — the app&rsquo;s public address</div>
          <div style={SECTION_HELP}>
            A billing approval email carries a link the client&rsquo;s rep taps to sign. That link
            points at the address below — the URL this app is hosted at, with no path on the end.
            Left blank, links fall back to a plain, unstyled page that still works but looks like a
            technical document rather than an invoice.
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
            What the field invoice prints besides the charges. A ticket takes its invoice number
            the moment it is marked invoiced on the billing tracker &mdash; the numbers start at 1000,
            run in order, and are never reused, so a ticket pulled back and re-invoiced keeps the
            number the client already has. Anything left blank here simply doesn&rsquo;t print.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="Terms">
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
            <Field label="Remit to">
              <textarea className="input" rows={4} value={form.invoiceRemitTo}
                onChange={e => set("invoiceRemitTo", e.target.value)}
                placeholder={"Where the money goes — printed under the total, line breaks kept.\nVagaboNDE Inc.\nPO Box 000, Grande Prairie, AB"}
                style={{ width: "100%" }} />
            </Field>
          </div>
        </Blueprint>

        <Blueprint style={{ padding: "18px 20px", minWidth: 0 }}>
          <div style={SECTION_TITLE}>Team chat GIFs</div>
          <div style={SECTION_HELP}>
            The chat&rsquo;s GIF picker searches <a href="https://klipy.com" target="_blank" rel="noreferrer">KLIPY</a>.
            Sign up for their free developer account, create an app, and paste its API key here.
            Entirely optional — without it, chat works fine and the GIF button explains itself.
          </div>
          <Field label="KLIPY API key">
            <input className="input" type="password" value={form.klipyApiKey}
              onChange={e => set("klipyApiKey", e.target.value)}
              placeholder="from klipy.com — optional" autoComplete="off" style={{ width: "100%" }} />
          </Field>
        </Blueprint>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {loadState === "failed" && <Btn variant="secondary" onClick={load}>Try loading again</Btn>}
          <Btn variant="primary" disabled={saving || loadState !== "ready"} onClick={save}>{saving ? "Saving…" : "Save settings"}</Btn>
        </div>

        <Blueprint style={{ padding: "18px 20px", minWidth: 0 }}>
          <div style={SECTION_TITLE}>Send a test email</div>
          <div style={SECTION_HELP}>
            Goes through the same path as a real report, so a delivered test means the email setup is
            done. Save the settings first.
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
  const load = (functionName = fn, withNames = false) => {
    setLoading(true);
    // The reason the last read failed is not the reason for this one, and
    // leaving it up made every later Refresh look like it had failed too.
    setErr("");
    Promise.all([Db.listFunctionErrors(PAGE, { functionName }), withNames ? Db.listFunctionErrorNames().catch(() => null) : null])
      .then(([rows, seen]) => { setErrors(rows); setMore(rows.length === PAGE); if (seen) setNames(seen); })
      .catch(e => setErr(e.message || "Couldn't load recent errors."))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(fn, true); }, []);

  const loadMore = async () => {
    const last = errors[errors.length - 1];
    if (!last) return;
    setLoadingMore(true);
    setErr("");
    try {
      const rows = await Db.listFunctionErrors(PAGE, { before: last, functionName: fn });
      setErrors(p => p.concat(rows));
      setMore(rows.length === PAGE);
    } catch (e) {
      setErr(e.message || "Couldn't load older errors.");
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
            <select className="input" aria-label="Which function" value={fn}
              style={{ width: "auto", minHeight: 34, padding: "4px 8px", fontSize: 13 }}
              onChange={e => { setFn(e.target.value); load(e.target.value); }}>
              <option value="">All functions</option>
              {names.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          <Btn variant="secondary" onClick={() => load(fn, true)} disabled={loading || clearing}>{loading ? "Loading…" : "Refresh"}</Btn>
          <Btn variant="danger" onClick={clear} disabled={loading || clearing || !errors.length}>{clearing ? "Clearing…" : "Clear"}</Btn>
        </span>
      </div>
      <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 14 }}>
        Failures in report emails, ticket approvals, PDF rendering, and account removal — logged here so they don't go unnoticed.
      </div>
      <ErrorBox>{err}</ErrorBox>
      {!loading && !errors.length && !err && (
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Nothing logged — everything's been going through cleanly.</div>
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
