// Who a chase from Ask would mail — vite-app/src/chasePlan.js's twin, the
// tracker's own three skips applied to the same rows, so "Chase all
// unsigned" and Ask's chase_unsigned can never disagree about who is left
// alone. Pure, no imports (backupShared.test.mjs guards that); the core
// between the markers is held to the panel's copy by askTwins.test.mjs.
// Below the core: the words the card shows for a plan.

export interface ChaseRow { id: string; contactLabel: string; chasedAt: string | null; queriedAt: string | null }
export interface ChaseDue { id: string; to: string }
export interface ChasePlan { due: ChaseDue[]; queried: string[]; recent: string[]; noEmail: string[] }
export interface ChaseOptions { emailIn: (s: string | null | undefined) => string; recentDays?: number; nowMs?: number }

// ═══ shared core (twin: vite-app/src/chasePlan.js) ═══
// Chased on Tuesday is chased: a client nudged then does not need the same
// email again on Thursday.
export const CHASE_RECENT_DAYS = 3;

// data.js's withinDays, against a clock the caller may hand in.
const recentlyChased = (ts: string | null, days: number, nowMs: number): boolean => {
  if (!ts) return false;
  const t = Date.parse(ts);
  return !Number.isNaN(t) && (nowMs - t) < days * 86400000;
};

// list: rows from Db.listUnsignedTicketContacts — { id, contactLabel,
// chasedAt, queriedAt }. Returns the tickets due a chase, each with the
// address its link will go to, and the three skipped buckets as id lists so
// the caller can count them or name them.
//
// The order of the tests is the meaning: a queried ticket that was also
// chased yesterday and has no address is reported once, as queried, because
// that is the reason the office needs to act on.
export function planChase(list: ChaseRow[] | null | undefined, { emailIn, recentDays = CHASE_RECENT_DAYS, nowMs = Date.now() }: ChaseOptions): ChasePlan {
  const due: ChaseDue[] = [], queried: string[] = [], recent: string[] = [], noEmail: string[] = [];
  for (const t of list || []) {
    // A rep who pressed "Query this ticket" is waiting on the office, not on
    // a reminder — and a resend clears the query, so chasing this one would
    // rub out the question before anybody answered it and ask the same rep
    // to sign the same figures again.
    if (t.queriedAt) { queried.push(t.id); continue; }
    if (recentlyChased(t.chasedAt, recentDays, nowMs)) { recent.push(t.id); continue; }
    // The rep's address as the ticket carries it. The contact label is
    // free text ("Dana Reyes <dana@acme.ca>"), so the address is whatever
    // reads as one inside it; a label with none means nobody to send to.
    const to = emailIn(t.contactLabel);
    if (!to) { noEmail.push(t.id); continue; }
    due.push({ id: t.id, to });
  }
  return { due, queried, recent, noEmail };
}
// ═══ end shared core ═══

// How many ticket numbers the words list before "and N more".
export const CHASE_LIST_LIMIT = 20;

const some = (ids: string[]): string => {
  const shown = ids.slice(0, CHASE_LIST_LIMIT).join(", ");
  const rest = ids.length - CHASE_LIST_LIMIT;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
};

// The card's summary and the done sentence, naming who is left alone and
// why — the tracker's confirm dialog in one line. A plan with nothing due
// is a refusal in words the model can pass on. `scope` is " for Pembina" or
// " older than 14 days" or "", the narrowing the person asked for.
export function chaseWords(plan: ChasePlan, scope: string): { summary: string; done: string; skipped: string } {
  const parts: string[] = [];
  if (plan.queried.length) parts.push(`${plan.queried.length} left alone — the client has a question open (${some(plan.queried)})`);
  if (plan.recent.length) parts.push(`${plan.recent.length} left alone — sent or chased in the last ${CHASE_RECENT_DAYS} days`);
  if (plan.noEmail.length) parts.push(`${plan.noEmail.length} skipped — no client email on file (${some(plan.noEmail)})`);
  const skipped = parts.join("; ");
  if (!plan.due.length) throw new Error(`Nothing to chase${scope}: ${skipped || "no ticket is awaiting approval"}.`);
  const n = plan.due.length;
  return {
    summary: `Chase ${n} unsigned ticket${n === 1 ? "" : "s"}${scope} — resend the approval link for ${some(plan.due.map(d => d.id))}?${skipped ? ` ${skipped}.` : ""}`,
    done: `Chasing ${n} ticket${n === 1 ? "" : "s"}${scope}. Progress shows in the toast, with Stop; the tracker shows each ticket as chased once its link has gone.`,
    skipped
  };
}
