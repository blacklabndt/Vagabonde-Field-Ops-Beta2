// "Am I done for the day?" — what a day's job still needs, decided from the
// records Ask read as the person. Pure, no imports (backupShared.test.mjs
// guards that); dayCheck.test.mjs holds the phrases.
//
// A working day, as the knowledge says it: the JHA filed and sent, the
// report uploaded and sent to the contractor, the ticket raised and sent to
// the client rep for approval. Each gap is a plain phrase the answer can
// repeat; a ticket with no helper on it is a note and never a gap, because
// working alone is a real day out here.

export interface DayJha { sent_at: string | null }
export interface DayTicket { id: string; status: string | null; approval_sent_at: string | null; helper: boolean }
export interface DayReport { sent_at: string | null }
export interface DayJob { job_number: string; jhas: DayJha[]; tickets: DayTicket[]; reports: DayReport[] }
export interface DayCheck {
  job_number: string;
  jha: { filed: boolean; sent: boolean };
  report: { uploaded: boolean; sent: boolean };
  ticket: { exists: boolean; id: string | null; status: string | null; sent: boolean; helper: boolean };
  missing: string[];
  notes: string[];
  done: boolean;
}

// A ticket that has been sent is one past Draft, or one carrying a sent stamp.
const SENT_STATUSES = ["Awaiting approval", "Approved", "Invoiced"];
const rank = (t: DayTicket): number => t.status === "Invoiced" ? 3 : t.status === "Approved" ? 2 : t.status === "Awaiting approval" ? 1 : 0;

export function dayCheck(job: DayJob): DayCheck {
  const jha = { filed: job.jhas.length > 0, sent: job.jhas.some(j => !!j.sent_at) };
  const report = { uploaded: job.reports.length > 0, sent: job.reports.some(r => !!r.sent_at) };
  // The day's furthest-along ticket is the one that counts; a spare draft
  // beside a sent ticket is not a gap.
  const best = [...job.tickets].sort((a, b) => rank(b) - rank(a))[0] ?? null;
  const ticket = {
    exists: !!best, id: best?.id ?? null, status: best?.status ?? null,
    sent: !!best && (SENT_STATUSES.includes(best.status ?? "") || !!best.approval_sent_at),
    helper: !!best?.helper
  };
  const missing: string[] = [];
  const notes: string[] = [];
  if (!jha.filed) missing.push("no JHA filed"); else if (!jha.sent) missing.push("JHA not sent");
  if (!report.uploaded) missing.push("no report uploaded"); else if (!report.sent) missing.push("report not sent");
  if (!ticket.exists) missing.push("no ticket yet");
  else {
    if (!ticket.sent) missing.push(`ticket ${ticket.id} not sent for approval`);
    if (!ticket.helper) notes.push(`no helper on ticket ${ticket.id} (fine if you worked alone)`);
  }
  return { job_number: job.job_number, jha, report, ticket, missing, notes, done: missing.length === 0 };
}
