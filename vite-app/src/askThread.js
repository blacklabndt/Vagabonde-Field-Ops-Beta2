// Ask's thread, held in memory for the session and nowhere else: a screen
// change keeps it, sign-out forgets it (App.jsx calls forgetAskThread
// beside forgetHeldDrafts), a reload starts clean. The trace under an
// answer is for the panel alone and never goes back to the function.
//
// Pure, so it is tested; the panel is the only importer besides App.

export const ASK_KEEP = 24;

let turns = [];

export function askTurns() { return turns.slice(); }

export function pushTurn(role, text, trace) {
  const turn = { role, text };
  if (trace && trace.length) turn.trace = trace.slice();
  turns = [...turns, turn].slice(-ASK_KEEP);
}

export function threadForSend() { return turns.map(t => ({ role: t.role, text: t.text })); }

export function forgetAskThread() { turns = []; }

// The recogniser's results for one utterance, folded into one line. Chrome
// hands them over in two shapes and says which nowhere: segments that
// follow one another ("which tickets", "are over sixty") and, on Android
// and some desktop builds, a growing list where each entry repeats the
// whole utterance so far ("which", "which tickets", "which tickets are").
// Concatenating the second shape printed the first word over and over
// (Kyle heard it, 10 Sept). So an entry that extends what is already
// folded — or is contained in it — replaces it; only a new segment
// appends. Compared without case, since the first word arrives
// capitalised once it is final.
export function foldTranscripts(transcripts) {
  let acc = "";
  for (const raw of transcripts || []) {
    const t = String(raw || "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    const a = acc.toLowerCase();
    const b = t.toLowerCase();
    if (!acc || b.startsWith(a)) acc = t;
    else if (!a.startsWith(b)) acc = `${acc} ${t}`;
  }
  return acc;
}

// What the box shows while the person is dictating: whatever was typed
// before the mic was pressed, then the utterances already finished, then
// the one being spoken — a rebuild each time, never an append.
export function mergeDictation(base, finals, interim) {
  const spoken = `${finals || ""}${interim || ""}`.replace(/\s+/g, " ").trim();
  const typed = String(base || "").replace(/\s+$/, "");
  if (!spoken) return typed;
  return typed ? `${typed} ${spoken}` : spoken;
}

// An answer's text split into plain runs and real job numbers, by
// membership against the job list (the chat's rule — job numbers are
// freeform, so a pattern would link things that are not jobs).
export function jobLinks(text, jobNums) {
  if (!jobNums || !jobNums.size) return [{ text: String(text) }];
  const out = [];
  const push = t => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && "text" in last) last.text += t;
    else out.push({ text: t });
  };
  String(text).split(/([A-Za-z0-9][A-Za-z0-9-]{2,19})/g).forEach((part, i) => {
    if (i % 2 === 1 && /\d/.test(part) && jobNums.has(part.toUpperCase())) out.push({ job: part });
    else push(part);
  });
  return out.length ? out : [{ text: "" }];
}
