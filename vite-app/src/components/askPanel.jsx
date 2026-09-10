import { useEffect, useRef, useState } from "react";
import { Db } from "../db.js";
import { Btn } from "./common.jsx";
import { askTurns, pushTurn, threadForSend, dropAction, isSendAction, jobLinks, mergeDictation, foldTranscripts } from "../askThread.js";

// Ask: a square launcher at the bottom right of every screen (it says
// "AI", per Kyle) and the card it opens. Not a dialog — no backdrop, the
// screen stays usable — so the person can read the tracker while asking
// about it. The thread is askThread.js's, in memory for the session; a
// failed question stays in the box with the reason under it, and the turn
// is pushed only once an answer has come back, so the thread never
// carries a question with no answer. Job numbers in an answer open the
// job, by membership against the job list as the chat does.
//
// Dictation is the browser's own speech recognition (Chrome, Edge, Safari
// on the tablets): no key, no server of ours, nothing stored. The mic
// button hides itself where the browser has none. Words land in the box
// as they are recognised — mergeDictation rebuilds it from what was typed
// before the mic was pressed plus the whole session so far — and Send or
// a second press on the mic stops listening.

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

const Recognition = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

// Dictation into a draft. `setDraft` takes the rebuilt text; `onFail` a
// sentence for the person when the microphone is refused or the browser
// gives up. start() remembers the draft at that moment as the base.
//
// One utterance per recogniser session, not continuous mode: continuous
// is where Chrome re-sends earlier results and the first word came out
// several times over. The session ends itself at a pause; while the mic
// is still wanted a fresh one starts, the finished utterance moves into
// `finals`, and the box is rebuilt from base + finals + the utterance in
// progress. Each utterance's results go through foldTranscripts, which
// takes the cumulative shape and the segmented shape alike.
function useDictation(getDraft, setDraft, onFail) {
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const wantRef = useRef(false);
  const baseRef = useRef("");
  const finalsRef = useRef("");
  const utteranceRef = useRef("");

  const stop = () => {
    wantRef.current = false;
    const rec = recRef.current;
    recRef.current = null;
    if (rec) { try { rec.stop(); } catch { /* already stopped */ } }
    setListening(false);
  };

  const show = () => setDraft(mergeDictation(baseRef.current, finalsRef.current, utteranceRef.current));

  const session = () => {
    const rec = new Recognition();
    rec.lang = "en-CA";
    rec.interimResults = true;
    rec.continuous = false;
    utteranceRef.current = "";
    rec.onresult = e => {
      const heard = [];
      for (let i = 0; i < e.results.length; i++) heard.push(e.results[i][0].transcript);
      utteranceRef.current = foldTranscripts(heard);
      show();
    };
    rec.onerror = e => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        onFail("The microphone was refused — allow it for this site to dictate.");
        stop();
      } else if (e.error !== "aborted" && e.error !== "no-speech") {
        onFail("Dictation stopped: the browser couldn't hear you.");
        stop();
      }
      // no-speech and aborted: onend follows and decides whether to go on.
    };
    rec.onend = () => {
      if (recRef.current !== rec) return;
      if (utteranceRef.current) {
        finalsRef.current = finalsRef.current ? `${finalsRef.current} ${utteranceRef.current}` : utteranceRef.current;
        utteranceRef.current = "";
        show();
      }
      recRef.current = null;
      if (wantRef.current) {
        try { session(); } catch { stop(); }
      } else {
        setListening(false);
      }
    };
    recRef.current = rec;
    rec.start();
  };

  const start = () => {
    if (!Recognition || recRef.current) return;
    baseRef.current = getDraft();
    finalsRef.current = "";
    utteranceRef.current = "";
    wantRef.current = true;
    setListening(true);
    try { session(); } catch { stop(); }
  };

  // Closing the card, or leaving the app, stops the microphone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs at unmount alone; stop reads refs, never state
  useEffect(() => stop, []);

  return { supported: !!Recognition, listening, start, stop };
}

function Answer({ text, jobNums, onOpenJob }) {
  return jobLinks(text, jobNums).map((p, i) =>
    "job" in p
      ? <button key={i} type="button" className="ask-job" onClick={() => onOpenJob(p.job)}>{p.job}</button>
      : <span key={i}>{p.text}</span>
  );
}

function AskCard({ onClose, onOpenJob, onAction }) {
  const [turns, setTurns] = useState(askTurns);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // A proposed send going out — the card stays open for the answer.
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [jobNums, setJobNums] = useState(null);
  const threadEl = useRef(null);
  const boxEl = useRef(null);
  const draftRef = useRef("");
  draftRef.current = draft;
  const mic = useDictation(() => draftRef.current, setDraft, setError);

  // The job list for the links, read once the card opens; a failed read
  // only costs the links.
  useEffect(() => {
    Db.listJobNumbers()
      .then(list => setJobNums(new Set(list.map(n => String(n).toUpperCase()))))
      .catch(() => setJobNums(new Set()));
  }, []);

  useEffect(() => {
    const el = threadEl.current;
    if (el) el.scrollTop = el.scrollHeight;
    if (!busy && boxEl.current) boxEl.current.focus();
  }, [turns, busy]);

  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = async () => {
    mic.stop();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      const { answer, trace, action } = await Db.ask([...threadForSend(), { role: "user", text }]);
      pushTurn("user", text);
      pushTurn("assistant", answer, trace, action);
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

  // The person said Send: App calls the same Db method Job detail's button
  // calls and answers a sentence, which becomes the answer turn so a later
  // question can see it went. A refusal — the function's own words — stays
  // on the error line with the proposal still up, for Not now.
  const confirmSend = async (i, action) => {
    if (sending || busy) return;
    setSending(true);
    setError("");
    try {
      const said = await onAction(action);
      dropAction(i);
      pushTurn("assistant", said || "Sent.");
      setTurns(askTurns());
    } catch (e) {
      setError(e.networkFailure
        ? "No connection — nothing was sent. Try again when you have signal."
        : (e.message || "Couldn't send it."));
    } finally {
      setSending(false);
    }
  };

  const toggleMic = () => {
    if (mic.listening) { mic.stop(); return; }
    setError("");
    mic.start();
  };

  return (
    <div className="ask-card" role="dialog" aria-label="AI">
      <div className="ask-card-head">
        <h3>AI</h3>
        <button type="button" className="btn btn-secondary" style={{ padding: "4px 10px" }}
          onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="ask-thread" ref={threadEl}>
        {!turns.length && (
          <div className="ask-turn-answer" style={{ opacity: 0.8 }}>
            Ask about the billing tracker — what needs attention, which tickets are over 60 days,
            how much a client owes. Answers come from what your account can see.
            {mic.supported && " Tap the microphone to say it instead of typing."}
          </div>
        )}
        {turns.map((t, i) => t.role === "user"
          ? <div key={i} className="ask-turn-user">{t.text}</div>
          : (
            <div key={i} className="ask-turn-answer">
              <Answer text={t.text} jobNums={jobNums} onOpenJob={onOpenJob} />
              {t.trace && t.trace.length > 0 && <div className="ask-trace">{t.trace.join(" · ")}</div>}
              {/* A proposal, on the latest answer only — an older one may
                  be about a job that has since been made. A draft's is the
                  app's own form, filled in, one tap away; nothing is
                  written until that form saves. A send's names every
                  address and waits for Send; nothing goes until then. */}
              {i === turns.length - 1 && t.action && (
                <div className="ask-proposal">
                  <div>{t.action.summary}</div>
                  {isSendAction(t.action) && (
                    <div className="ask-proposal-to">To: {(t.action.to || []).join(", ")}</div>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    {isSendAction(t.action)
                      ? <Btn variant="primary" disabled={sending} onClick={() => confirmSend(i, t.action)}>{sending ? "Sending…" : "Send"}</Btn>
                      : <Btn variant="primary" onClick={() => { onClose(); onAction(t.action); }}>Open the form</Btn>}
                    <Btn variant="secondary" disabled={sending} onClick={() => { dropAction(i); setTurns(askTurns()); }}>Not now</Btn>
                  </div>
                </div>
              )}
            </div>
          ))}
        {busy && <div className="ask-turn-answer" style={{ opacity: 0.7 }}>Reading the tracker…</div>}
      </div>
      {error && <div className="ask-error">{error}</div>}
      <div className="ask-foot">
        <textarea ref={boxEl} className="input" rows={2} value={draft}
          placeholder={mic.listening ? "Listening…" : "Ask about the tracker…"}
          onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown} disabled={busy || sending} />
        {mic.supported && (
          <button type="button" className={`btn btn-secondary ask-mic${mic.listening ? " ask-mic-on" : ""}`}
            onClick={toggleMic} disabled={busy || sending} aria-pressed={mic.listening}
            title={mic.listening ? "Stop listening" : "Say it instead of typing"}>
            {mic.listening ? "■" : "🎤"}
          </button>
        )}
        <Btn variant="primary" onClick={send} disabled={busy || sending || !draft.trim()}>Send</Btn>
      </div>
    </div>
  );
}

export function AskLauncher({ onOpenJob, onAction }) {
  const online = useOnline();
  const [open, setOpen] = useState(false);

  if (open) return <AskCard onClose={() => setOpen(false)} onOpenJob={onOpenJob} onAction={onAction} />;
  return (
    <button type="button" className="btn btn-primary ask-launcher" disabled={!online}
      title={online ? "Ask the app a question" : "AI needs a connection"} onClick={() => setOpen(true)}>
      AI
    </button>
  );
}
