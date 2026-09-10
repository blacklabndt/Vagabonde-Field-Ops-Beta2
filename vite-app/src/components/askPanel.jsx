import { useEffect, useRef, useState } from "react";
import { Db } from "../db.js";
import { Btn } from "./common.jsx";
import { askTurns, pushTurn, threadForSend, jobLinks } from "../askThread.js";

// Ask: a square launcher at the bottom right of every screen and the card
// it opens. Not a dialog — no backdrop, the screen stays usable — so the
// person can read the tracker while asking about it. The thread is
// askThread.js's, in memory for the session; a failed question stays in
// the box with the reason under it, and the turn is pushed only once an
// answer has come back, so the thread never carries a question with no
// answer. Job numbers in an answer open the job, by membership against
// the job list as the chat does.

function useOnline() {
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return online;
}

function Answer({ text, jobNums, onOpenJob }) {
  return jobLinks(text, jobNums).map((p, i) =>
    "job" in p
      ? <button key={i} type="button" className="ask-job" onClick={() => onOpenJob(p.job)}>{p.job}</button>
      : <span key={i}>{p.text}</span>
  );
}

export function AskLauncher({ onOpenJob }) {
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState(askTurns);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [jobNums, setJobNums] = useState(null);
  const threadEl = useRef(null);
  const boxEl = useRef(null);

  // The job list for the links, read once the card opens; a failed read
  // only costs the links.
  useEffect(() => {
    if (!open || jobNums) return;
    Db.listJobNumbers()
      .then(list => setJobNums(new Set(list.map(n => String(n).toUpperCase()))))
      .catch(() => setJobNums(new Set()));
  }, [open, jobNums]);

  useEffect(() => {
    if (!open) return;
    const el = threadEl.current;
    if (el) el.scrollTop = el.scrollHeight;
    if (!busy && boxEl.current) boxEl.current.focus();
  }, [open, turns, busy]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = e => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      const { answer, trace } = await Db.ask([...threadForSend(), { role: "user", text }]);
      pushTurn("user", text);
      pushTurn("assistant", answer, trace);
      setTurns(askTurns());
      setDraft("");
    } catch (e) {
      setError(e.networkFailure
        ? "No connection — your question is still here, try again when you have signal."
        : (e.message || "Ask couldn't answer."));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-primary ask-launcher" disabled={!online}
        title={online ? "Ask the app a question" : "Ask needs a connection"} onClick={() => setOpen(true)}>
        Ask
      </button>
    );
  }

  return (
    <div className="ask-card" role="dialog" aria-label="Ask">
      <div className="ask-card-head">
        <h3>Ask</h3>
        <button type="button" className="btn btn-secondary" style={{ padding: "4px 10px" }}
          onClick={() => setOpen(false)} aria-label="Close">×</button>
      </div>
      <div className="ask-thread" ref={threadEl}>
        {!turns.length && (
          <div className="ask-turn-answer" style={{ opacity: 0.8 }}>
            Ask about the billing tracker — what needs attention, which tickets are over 60 days,
            how much a client owes. Answers come from what your account can see.
          </div>
        )}
        {turns.map((t, i) => t.role === "user"
          ? <div key={i} className="ask-turn-user">{t.text}</div>
          : (
            <div key={i} className="ask-turn-answer">
              <Answer text={t.text} jobNums={jobNums} onOpenJob={onOpenJob} />
              {t.trace && t.trace.length > 0 && <div className="ask-trace">{t.trace.join(" · ")}</div>}
            </div>
          ))}
        {busy && <div className="ask-turn-answer" style={{ opacity: 0.7 }}>Reading the tracker…</div>}
      </div>
      {error && <div className="ask-error">{error}</div>}
      <div className="ask-foot">
        <textarea ref={boxEl} className="input" rows={2} value={draft} placeholder="Ask about the tracker…"
          onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown} disabled={busy} />
        <Btn variant="primary" onClick={send} disabled={busy || !draft.trim()}>Send</Btn>
      </div>
    </div>
  );
}
