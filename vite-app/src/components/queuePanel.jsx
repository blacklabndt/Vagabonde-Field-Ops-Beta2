import React, { useState } from "react";
import { Blueprint, Btn, TagX, Dialog, ErrorBox } from "./common.jsx";
import { OfflineQueue } from "../offlineQueue.js";

// What's still waiting to reach the database, and — the part that was missing
// — what has stopped trying.
//
// The queue already recorded why an item failed; nothing ever showed it. A
// ticket that will never sync (its job was completed while the crew was out
// of range) counted in the same "3 queued" badge as one that was about to go
// through, and the panel promised both would send automatically. The person
// who raised it found out when the invoice didn't.

const LABELS = {
  job: "New job",
  jha: "Hazard assessment",
  report: "Radiographic report",
  ticket: "Billing ticket"
};

const describe = item => {
  const what = LABELS[item.type] || item.type;
  const p = item.payload || {};
  if (item.type === "job") return `${what} ${p.jobNumber || ""}${p.project ? " · " + p.project : ""}`.trim();
  if (item.type === "ticket") return `${what}${p.ticketId ? " " + p.ticketId : ""}${p.workDate ? " · " + p.workDate : ""}`;
  if (item.type === "report") return `${what}${p.file && p.file.name ? " · " + p.file.name : ""}${p.jobNumber ? " · " + p.jobNumber : ""}`;
  return what;
};

const ago = ts => {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
};

// The top-bar badge. Two states, deliberately different: waiting is
// reassurance, stuck is a call to action.
export function QueueBadge({ items, onOpen }) {
  const stuck = items.filter(i => i.lastError);
  if (!items.length) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={stuck.length ? "tag tag-bad" : "tag tag-warn"}
      style={{ cursor: "pointer", font: "inherit" }}
      title={stuck.length
        ? `${stuck.length} item${stuck.length === 1 ? "" : "s"} couldn't sync — tap for the reason`
        : "Saved on this device — syncing automatically once you're back in range"}
    >
      {stuck.length ? `${stuck.length} won't sync` : `${items.length} queued`}
    </button>
  );
}

// The refusal updateTicket raises when a queued Draft lands on a row the
// office has since sent out (data.js, ticketStatusWriteRefusal). Matched on
// its words rather than a flag because the queue only ever kept the message.
const SENT_FOR_SIGNATURE = /sent for the client's signature/i;

// What discarding actually throws away. For most items the outbox holds the
// only copy, which is what this prompt has always said — and for those it is
// still true. Two of them it was never true of: a ticket reopened offline, or
// one whose replay got as far as creating the row before the signal went, is
// alreadyCreated and has its number; a report whose PDF uploaded carries the
// reportId its checkpoint wrote, and only the emailing is still owed. Telling
// either of those "nothing else holds a copy" invited a discard on the belief
// the whole thing would go with it. It doesn't — only the day's edits do, and
// those are the part that can't be got back.
const discardPrompt = item => {
  const what = (LABELS[item.type] || item.type).toLowerCase();
  const p = item.payload || {};
  if (item.type === "ticket" && p.alreadyCreated) {
    const asNumber = p.ticketId ? ` as ${p.ticketId}` : "";
    // The signature refusal only stops the billing half: crew rows stay
    // writable until the client signs, so the replay files those hours
    // before it parks the item. Saying "only the changes made on this
    // device are thrown away" of that item would be twice wrong — the
    // hours are already on the ticket, and the welds and charges are the
    // one thing a discard really does end.
    if (SENT_FOR_SIGNATURE.test(item.lastError || "")) {
      return `Discard this ${what}? The ticket itself is already saved${asNumber} and has gone to the client for signature — it stays exactly as it is, and the crew hours entered on this device are already on it. Only its welds and charges from this device were never applied; discarding gives up on them, and they can't be got back.`;
    }
    return `Discard this ${what}? The ticket itself is already saved${asNumber} — it stays exactly as it is. Only the changes made on this device are thrown away, and they can't be got back.`;
  }
  if (item.type === "report" && p.reportId) {
    return `Discard this ${what}? The PDF is already uploaded and on the job — it stays there. Only what is still owed here${p.recipient ? `, the email to ${p.recipient},` : ""} is thrown away. This can't be undone.`;
  }
  return `Discard this ${what}? It has never reached the database, and nothing else holds a copy of it. This can't be undone.`;
};

export function QueueDialog({ items, onRetry, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stuck = items.filter(i => i.lastError);
  const waiting = items.filter(i => !i.lastError);

  const retry = async () => {
    setBusy(true);
    setError("");
    try { await onRetry(); }
    catch (e) { setError(e.message || "Still couldn't sync."); }
    setBusy(false);
  };

  const discard = async item => {
    if (!confirm(discardPrompt(item))) return;
    setError("");
    try { await OfflineQueue.remove(item.id); }
    catch (e) { setError(e.message || "Couldn't discard that item."); }
  };

  return (
    <Dialog title="Waiting to sync" maxWidth={560} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose}>Close</Btn>
        <Btn variant="primary" onClick={retry} disabled={busy || !items.length}>
          {busy ? "Trying…" : "Try again now"}
        </Btn>
      </>}>
      <ErrorBox>{error}</ErrorBox>

      {!items.length && (
        <div style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
          Everything has synced. Nothing is waiting on this device.
        </div>
      )}

      {stuck.length > 0 && (
        <>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)" }}>
            Stopped — needs a decision
          </div>
          <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
            These reached the database and were refused, so waiting for signal won't help. Fix what the message describes and try again, or discard the item if it is no longer wanted.
          </div>
          {stuck.map(item => (
            <Blueprint key={item.id} style={{ padding: "12px 14px", display: "grid", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>{describe(item)}</span>
                <span style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>saved {ago(item.createdAt)}</span>
                <Btn variant="ghost" style={{ marginLeft: "auto" }} onClick={() => discard(item)}>Discard</Btn>
              </div>
              <div style={{ fontSize: 13, color: "var(--color-accent-700)" }}>{item.lastError}</div>
              {/* The refusal is only half the story, and the half it leaves
                  out is the one that decides what to do: the hours are on
                  the ticket, the billing is not, and nothing here will
                  change that until the approval is cancelled. */}
              {item.type === "ticket" && SENT_FOR_SIGNATURE.test(item.lastError || "") && (
                <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
                  The crew hours entered on this device were saved on it. Only its welds and charges were not applied — cancel the approval and re-enter them, then discard this item.
                </div>
              )}
              {/* The replay said this once, in a toast, on whatever screen
                  happened to be open while the outbox drained. An item that
                  then stopped for some other reason is the one place the
                  panel can still carry it, so it does. Items that finish are
                  deleted, and this is not shown for those. */}
              {item.type === "ticket" && (item.payload || {}).overwroteNewer && (
                <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
                  This device's copy replaced changes somebody else had saved while it was out of range. Open the ticket and check the figures.
                </div>
              )}
            </Blueprint>
          ))}
        </>
      )}

      {waiting.length > 0 && (
        <>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            Waiting for signal
          </div>
          {waiting.map(item => (
            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, padding: "4px 0" }}>
              <TagX variant="outline">queued</TagX>
              <span>{describe(item)}</span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>saved {ago(item.createdAt)}</span>
            </div>
          ))}
        </>
      )}
    </Dialog>
  );
}
