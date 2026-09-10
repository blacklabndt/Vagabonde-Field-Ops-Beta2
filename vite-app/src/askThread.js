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
