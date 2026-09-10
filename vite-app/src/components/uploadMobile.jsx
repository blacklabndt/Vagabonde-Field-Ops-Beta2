import { useState, useEffect } from "react";
import { Db } from "../db.js";
import { Blueprint, Btn, TagX, ErrorBox, emailIn, NoJobSelected, ConnectionBar, QueuedPanel } from "./common.jsx";
import { fileSize, reportFileRefusal, MAX_REPORT_LABEL } from "../data.js";
import { OfflineQueue } from "../offlineQueue.js";
import { savingLabel, deviceOffline } from "../savingWords.js";

export function UploadMobileScreen({ job, jobRecord, currentUser, onSent }) {
  const [items, setItems] = useState([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [queued, setQueued] = useState(false);
  // Typed inline rather than through prompt(): a native prompt is a no-op in
  // some embedded preview hosts (it returns immediately with no dialog), and
  // on a phone it hides the file it is asking about behind a system sheet.
  // Declared before the early returns below — hooks must run in the same
  // order every render, and the moment setQueued(true) fired, the next
  // render returned early, called one hook fewer, and React threw instead
  // of showing the queued panel.
  const [weldDraft, setWeldDraft] = useState({});
  // How long the send on screen has been waiting, which is what decides the
  // button's wording (savingLabel). Measured from a start stamp rather than
  // counted in ticks, because a phone that dims its screen throttles the
  // interval and a tick count would report a wait shorter than it was.
  // Declared with the other hooks, above the early returns, for the same
  // reason the weld draft is.
  const [sendingMs, setSendingMs] = useState(0);
  useEffect(() => {
    if (!sending) { setSendingMs(0); return undefined; }
    const startedAt = Date.now();
    const id = setInterval(() => setSendingMs(Date.now() - startedAt), 250);
    return () => clearInterval(id);
  }, [sending]);
  if (queued) return <QueuedPanel what="the report" onDone={onSent} />;
  if (!job) return <NoJobSelected what="a report" />;

  const attach = e => {
    const f = e.target.files[0];
    // Clear the input, or picking the same file twice in a row fires no
    // change event and looks like the app ignored the second tap.
    e.target.value = "";
    if (!f) return;
    // `accept=` on the input is a picker filter and nothing more: "All files"
    // in the picker, or a share sheet, hands over whatever was chosen. A .txt
    // and a 25 MB blank PDF both went up without a word, and a report nobody
    // can open is only discovered by the contractor.
    const refused = reportFileRefusal(f);
    if (refused) { setError(refused); return; }
    setError("");
    // A stable key per attachment, not the array index: everything below —
    // the row, its weld chips, its half-typed draft — is keyed by it, so
    // removing one file can't shift another file's state onto the wrong row.
    const key = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
    // The save's idempotency key is a uuid or nothing (reports.client_key is
    // a uuid column): the row key's fallback is fine for React and fatal
    // for the insert, and on a browser without randomUUID it was making the
    // phone unable to file a report at all.
    const clientKey = crypto.randomUUID ? key : null;
    setItems(p => [...p, { key, clientKey, file: f, welds: [], state: "Queued" }]);
  };
  const addWeld = key => {
    const w = (weldDraft[key] || "").trim();
    if (!w) return;
    // Ignore a repeat of a weld already on this row. A weld ID is unique on a
    // report, so a second entry is always a typo or losing track — and
    // allowing it broke two things: the chips key by weld value, so
    // duplicates collided as React keys, and removeWeld filters by value, so
    // tapping one duplicate's × deleted every copy. Deduping keeps values
    // unique, which makes both the key and the remove correct.
    setItems(p => p.map(it => it.key === key
      ? (it.welds.includes(w) ? it : { ...it, welds: [...it.welds, w] })
      : it));
    setWeldDraft(p => ({ ...p, [key]: "" }));
  };
  const removeWeld = (key, weld) =>
    setItems(p => p.map(it => it.key === key ? { ...it, welds: it.welds.filter(w => w !== weld) } : it));
  const removeItem = key => {
    setItems(p => p.filter(it => it.key !== key));
    setWeldDraft(p => { const next = { ...p }; delete next[key]; return next; });
  };

  const recipient = emailIn(jobRecord.contractorRep);

  const sendAll = async () => {
    if (!items.length) return;
    // The desktop dialog refuses a report with no welds listed, and so must
    // this: the contractor otherwise gets a row that says nothing about
    // which welds it covers, and reconciling it against the film has
    // nothing to go on.
    const unlabelled = items.find(it => !it.welds.length);
    if (unlabelled) { setError(`Note which welds ${unlabelled.file.name} covers before sending.`); return; }
    setSending(true);
    setError("");
    let failedAt = null;
    let queuedCount = 0;
    // Asked once, at the press, rather than per file: the answer decides how
    // this whole package is handled, and a radio flickering back for one file
    // in the middle would split a package across two homes for no gain. A
    // device that comes back into range mid-loop still uploads on the next
    // press; one that drops mid-loop still lands in the outbox, by the
    // network-error branch below.
    const noSignal = deviceOffline();
    try {
      for (const it of items) {
        // Stored on the server, or bound for the outbox — this file is
        // accounted for either way, and how it got there decides nothing
        // except which of the two happens next.
        let toQueue = false;
        try {
          // There is nothing to learn from asking a radio that is already
          // off: waiting for the answer cost about eight seconds a file — a
          // token refresh and then the upload, each having to time out —
          // with the screen dimmed and silent, before arriving at this same
          // outbox. Straight to the outbox instead.
          //
          // Otherwise: each file leaves the list the moment it is safely
          // stored (or queued), not when the whole loop finishes — a failure
          // on the second file used to keep the first one in the list, and
          // the retry filed it again, report row, email and all.
          // `send` stamps `sent_at` on the row; it does not send anything. This
          // screen used to pass `send: true` and no email, so every report from
          // a phone was recorded as delivered to the contractor while nothing
          // ever left the building. Store first, then actually email.
          // The row's key doubles as the save's idempotency key: a lost
          // answer on the radio hands back the report that already landed
          // instead of filing it twice.
          if (noSignal) {
            toQueue = true;
          } else {
            const report = await Db.uploadReport({
              jobDbId: job.dbId, jobNumber: job.id, file: it.file,
              welds: it.welds.join(", "), result: "Accept", interpretedBy: currentUser.name,
              send: false, sendTo: recipient, clientKey: it.clientKey
            });
            if (recipient) {
              try {
                await Db.sendReportEmail({ reportId: report.id, to: recipient, cc: "", message: "" });
              } catch (mailErr) {
                failedAt = mailErr.message || "the email service didn't respond.";
              }
            }
          }
        } catch (e) {
          // A refusal the server gave (.plain) is shown, not queued, whatever
          // the radio says — the order the other two field screens keep.
          if (e.plain || !OfflineQueue.isNetworkError(e)) throw e;
          toQueue = true;
        }
        if (toQueue) {
          try {
            await OfflineQueue.enqueue("report", {
              jobDbId: job.dbId, jobNumber: job.id, file: it.file,
              welds: it.welds.join(", "), interpretedBy: currentUser.name, recipient, clientKey: it.clientKey
            });
          } catch {
            // A whole PDF goes into the outbox, so this is the enqueue most
            // likely to be refused for space. Unguarded, the raw IndexedDB
            // complaint was what the tech read. This file (and everything
            // after it) stays in the list, so nothing is lost by stopping.
            setSending(false);
            setError("No signal, and this device couldn't save it either — there may be no room left. The files are still listed here; try again once you're in range.");
            return;
          }
          queuedCount++;
        }
        // Stored or queued — either way this file is accounted for. Only a
        // thrown non-network error skips this, leaving exactly the
        // unaccounted files in the list for the retry.
        removeItem(it.key);
      }
      // The email failure comes first: the outbox has its own badge and panel
      // for what queued, but a report that uploaded and was never emailed has
      // nothing else to say so — and the queued panel replaces this whole
      // screen, taking the message with it.
      if (failedAt) {
        setError(`Uploaded, but the email didn't go out: ${failedAt} The reports are on file and show as Pending — resend from Job detail.${queuedCount ? " Anything with no signal is in the outbox." : ""}`);
      } else if (queuedCount) {
        setQueued(true);
      } else if (!recipient) {
        setError("Uploaded. No contractor email is on this job, so nothing was sent — add one in the job record and send from Job detail.");
      } else {
        onSent();
      }
    } catch (e) {
      setError(e.message || "Couldn't upload — try again.");
    }
    setSending(false);
  };

  return (
    <div className="page">
      <div className="phone-shell">
        <Blueprint className="phone-frame">
          <ConnectionBar />
          <div>
            <div className="kicker">{job.id} · Report upload</div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 22 }}>{job.project}</div>
          </div>

          <div className="blueprint" style={{ borderStyle: "dashed", padding: 16, textAlign: "center", position: "relative", fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
            <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
            Tap to attach a PDF — up to {MAX_REPORT_LABEL}
            <input type="file" accept="application/pdf" style={{ position: "absolute", inset: 0, opacity: 0 }} onChange={attach} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {items.map(it => (
              <div key={it.key} className="blueprint" style={{ padding: 10, position: "relative" }}>
                <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="pdf-glyph" style={{ width: 20, height: 26 }}>PDF</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.file.name}</div>
                    <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{fileSize(it.file.size)} · {currentUser.name}</div>
                  </div>
                  <TagX variant="neutral">{it.state}</TagX>
                  <button type="button" className="row-x" aria-label={`Remove ${it.file.name}`}
                    onClick={() => removeItem(it.key)}>×</button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, alignItems: "center" }}>
                  {it.welds.map(w => (
                    <button key={w} type="button" className="tag tag-neutral"
                      title={`Remove ${w}`} aria-label={`Remove weld ${w}`}
                      style={{ cursor: "pointer", background: "none" }}
                      onClick={() => removeWeld(it.key, w)}>{w} ×</button>
                  ))}
                  <input className="input" value={weldDraft[it.key] || ""} placeholder="+ weld"
                    aria-label={`Add a weld ID to ${it.file.name}`}
                    style={{ width: 110, minHeight: 34, fontSize: 12 }}
                    onChange={e => setWeldDraft(p => ({ ...p, [it.key]: e.target.value }))}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addWeld(it.key); } }}
                    onBlur={() => addWeld(it.key)} />
                </div>
              </div>
            ))}
            {items.length === 0 && <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Nothing attached yet.</div>}
          </div>

          <div style={{ fontSize: 11, color: recipient ? "color-mix(in srgb, var(--color-text) 55%, transparent)" : "var(--color-accent-700)" }}>
            {recipient
              ? `To: ${jobRecord.contractorRep}`
              : "No contractor email on this job — files will upload, but nothing will be sent."}
          </div>
          <ErrorBox>{error}</ErrorBox>
          <Btn variant="primary" block style={{ minHeight: 56, fontSize: 15 }} onClick={sendAll} disabled={sending || !items.length}>
            {sending ? savingLabel(sendingMs, "Sending…") : `Send package (${items.length} files)`}
          </Btn>
        </Blueprint>

        <div className="phone-explain">
          <p>The phone equivalent of the upload dialog — attach the interpreted PDF, tag which welds it covers, send. Each file uploads to the private <code>reports</code> storage bucket and writes a real row.</p>
        </div>
      </div>
    </div>
  );
}

