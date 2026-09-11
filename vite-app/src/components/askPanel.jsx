import { useEffect, useRef, useState } from "react";
import { Db } from "../db.js";
import { Btn } from "./common.jsx";
import { askTurns, pushTurn, threadForSend, dropAction, dropLearned, isConfirmAction, confirmLabel, formLabel, jobLinks, mergeDictation, foldTranscripts } from "../askThread.js";
import { downloadFile, fileToUpload } from "../askFiles.js";

// Ask: a square launcher at the bottom right of every screen (it says
// "Claudia", per Kyle) and the card it opens. Not a dialog — no backdrop, the
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

// The card's own words, in one place. Edit these; nothing else reads them.
export const CARD_WORDS = {
  // Shown before the first question.
  empty: "Ask me anything, i can create a new job, ticket, send jhas, i can even set a scheduled time to send out reports and billing",
  // Added to the above when the browser has a microphone.
  mic: " Tap the microphone to talk to me",
  // Under the thread while an answer is on its way.
  busy: "Procrastinating...",
  // The box, when it is empty.
  placeholder: "Type here"
};

function AskCard({ onClose, onOpenJob, onAction, closing, context, canSaveFiles }) {
  const [turns, setTurns] = useState(askTurns);
  // Turns from this index on arrived while the card was open and rise
  // into place; the ones before it were there when it opened and mount
  // still (the chat's rule — a thread animating on open is a screensaver).
  const arrivedFrom = useRef(askTurns().length);
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
      const { answer, trace, action, learned, files, learnTrouble } = await Db.ask([...threadForSend(), { role: "user", text }], context);
      pushTurn("user", text);
      pushTurn("assistant", answer, trace, action, learned, files, learnTrouble);
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

  // A file Ask made: the bytes are built here, on the device, from the
  // checked shape the function returned. Download is the person's own act;
  // Save to Files asks once and goes through the Files screen's own upload
  // into the Ask folder, where storage's policy decides.
  const [fileBusy, setFileBusy] = useState("");
  const [savePrompt, setSavePrompt] = useState("");
  const [saved, setSaved] = useState({});
  const fileKey = (i, k) => `${i}:${k}`;
  const download = async (key, f) => {
    setFileBusy(key);
    setError("");
    try { await downloadFile(f); }
    catch (e) { setError(e.message || "Couldn't build that file."); }
    finally { setFileBusy(""); }
  };
  const saveToFiles = async (key, f) => {
    setFileBusy(key);
    setSavePrompt("");
    setError("");
    try {
      await Db.uploadSharedFile("Ask", await fileToUpload(f));
      Db.forgetFileTree();
      setSaved(s => ({ ...s, [key]: true }));
    } catch (e) { setError(e.message || "Couldn't save that file."); }
    finally { setFileBusy(""); }
  };

  // The person said Send, Schedule or Cancel it: App calls the same Db
  // method Job detail's button calls and answers a sentence, which becomes
  // the answer turn so a later question can see it went. A refusal — the
  // function's own words — stays on the error line with the proposal still
  // up, for Not now.
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
        : (e.message || "Couldn't do that."));
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
    <div className={`ask-card${closing ? " closing" : ""}`} role="dialog" aria-label="Claudia">
      <div className="ask-card-head">
        <h3>Claudia</h3>
        <button type="button" className="btn btn-secondary" style={{ padding: "4px 10px" }}
          onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="ask-thread" ref={threadEl}>
        {!turns.length && (
          <div className="ask-turn-answer" style={{ opacity: 0.8 }}>
            {CARD_WORDS.empty}
            {mic.supported && CARD_WORDS.mic}
          </div>
        )}
        {turns.map((t, i) => t.role === "user"
          ? <div key={i} className={`ask-turn-user${i >= arrivedFrom.current ? " ask-turn-in" : ""}`}>{t.text}</div>
          : (
            <div key={i} className={`ask-turn-answer${i >= arrivedFrom.current ? " ask-turn-in" : ""}`}>
              <Answer text={t.text} jobNums={jobNums} onOpenJob={onOpenJob} />
              {t.trace && t.trace.length > 0 && <div className="ask-trace">{t.trace.join(" · ")}</div>}
              {t.files && t.files.length > 0 && (
                <div className="ask-files">
                  {t.files.map((f, k) => {
                    const key = fileKey(i, k);
                    const busy = fileBusy === key;
                    return (
                      <div key={key} className="ask-file">
                        <div className="ask-file-name">{f.words || f.name}</div>
                        {savePrompt === key
                          ? (
                            <div className="ask-file-actions">
                              <span>Save {f.name} to Files › Ask?</span>
                              <Btn variant="primary" disabled={busy} onClick={() => saveToFiles(key, f)}>Save</Btn>
                              <Btn variant="secondary" disabled={busy} onClick={() => setSavePrompt("")}>Not now</Btn>
                            </div>
                          )
                          : (
                            <div className="ask-file-actions">
                              <Btn variant="secondary" disabled={busy} onClick={() => download(key, f)}>{busy ? "Working…" : "Download"}</Btn>
                              {canSaveFiles && !saved[key] && (
                                <Btn variant="secondary" disabled={busy} onClick={() => setSavePrompt(key)}>Save to Files</Btn>
                              )}
                              {saved[key] && <span className="ask-file-saved">Saved to Files › Ask</span>}
                            </div>
                          )}
                      </div>
                    );
                  })}
                </div>
              )}
              {/* What this answer taught Ask about the app — kept on its own,
                  shown so it is never a secret, with an × that forgets it on
                  the spot: the person's own note, their own act. */}
              {t.learned && t.learned.length > 0 && (
                <div className="ask-learned">
                  {t.learned.map(n => (
                    <div key={n.id} className="ask-learned-note">
                      <span>Learned: {n.note}</span>
                      <button type="button" className="ask-learned-x" title="Forget this" aria-label={`Forget: ${n.note}`}
                        onClick={async () => {
                          setError("");
                          try { await Db.forgetLearned(n.id); } catch (e) { setError(e.message || "Couldn't forget that."); return; }
                          dropLearned(i, n.id);
                          setTurns(askTurns());
                        }}>×</button>
                    </div>
                  ))}
                </div>
              )}
              {/* A note that could NOT be kept, said beside the ones that
                  were. Silence here is what it replaced: the write's answer
                  was thrown away, so a note the database refused looked
                  exactly like one that landed — nothing on the card, and
                  nothing in the table either. It is not an error tone: the
                  answer above is sound, and only the remembering failed. */}
              {t.learnTrouble && (
                <div className="ask-learned">
                  <div className="ask-learned-note"><span>{t.learnTrouble}</span></div>
                </div>
              )}
              {/* A proposal, on the latest answer only — an older one may
                  be about a job that has since been made. A draft's is the
                  app's own form, filled in, one tap away; nothing is
                  written until that form saves. A send's names every
                  address and waits for Send; nothing goes until then. */}
              {i === turns.length - 1 && t.action && (
                <div className="ask-proposal">
                  <div>{t.action.summary}</div>
                  {isConfirmAction(t.action) && t.action.to && (
                    <div className="ask-proposal-to">To: {t.action.to.join(", ")}</div>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    {isConfirmAction(t.action)
                      ? <Btn variant="primary" disabled={sending} onClick={() => confirmSend(i, t.action)}>{sending ? "Working…" : confirmLabel(t.action)}</Btn>
                      : <Btn variant="primary" onClick={() => { onClose(); onAction(t.action); }}>{formLabel(t.action)}</Btn>}
                    <Btn variant="secondary" disabled={sending} onClick={() => { dropAction(i); setTurns(askTurns()); }}>Not now</Btn>
                  </div>
                </div>
              )}
            </div>
          ))}
        {busy && <div className="ask-turn-answer ask-busy">{CARD_WORDS.busy}</div>}
      </div>
      {error && <div className="ask-error">{error}</div>}
      <div className="ask-foot">
        <textarea ref={boxEl} className="input" rows={2} value={draft}
          placeholder={mic.listening ? "Listening…" : CARD_WORDS.placeholder}
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

// `context` is where the person is — App's screen key, the open job's
// number, the open ticket's id and the screen's help — sent with each
// question so "this job" needs no question back.
export function AskLauncher({ onOpenJob, onAction, context, canSaveFiles }) {
  const online = useOnline();
  const [open, setOpen] = useState(false);
  // Closing plays the card's exit first; the unmount follows on a timer a
  // little longer than the animation, so a shortened animation (the
  // Animations switch) still ends in a closed card.
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef(null);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  const close = () => {
    if (closing) return;
    setClosing(true);
    closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false); setClosing(false); }, 220);
  };

  if (open) return <AskCard onClose={close} onOpenJob={onOpenJob} onAction={onAction} closing={closing} context={context} canSaveFiles={canSaveFiles} />;
  return (
    <button type="button" className="btn btn-primary ask-launcher" disabled={!online}
      title={online ? "Ask the app a question" : "Claudia needs a connection"} onClick={() => setOpen(true)}>
      Claudia
    </button>
  );
}
