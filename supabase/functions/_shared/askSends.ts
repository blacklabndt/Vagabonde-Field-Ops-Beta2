// Who a send Ask proposes may go to, and the gates the screens apply —
// pure, so the node suite covers every refusal without a database. The
// function reads the record and the contacts as the caller and hands them
// in; nothing here sends, writes or reads the world (backupShared.test.mjs
// guards that).
//
// The recipient rule is stricter than Job detail's dialog on purpose: a
// person at the dialog picks from the job's contacts or types an address,
// and the model may do only those two things — a name must be a contact
// on file with an email, and a bare address must appear in the person's
// own words in the thread. An address the model took from a record, a
// query text or a guess is refused, whoever it claims to be.

export interface Person { id: string; name: string; email: string | null; org_type?: string }
export interface Me { id: string; role: string }
export interface JhaToSend {
  id: string; signed_by: string | null; pdf_key: string | null; template: string | null;
  work_date: string | null; sent_at?: string | null;
}
export interface TicketToSend {
  id: string; status: string | null; total: number | string | null; technician_id: string | null;
  approval_sent_at?: string | null;
}
export interface JobName { id: string; job_number: string }
export interface SendWords { summary: string; done: string }

// send-jha's own gate: the technician who filed it, or one of these.
export const JHA_SEND_ROLES = ["Admin", "Coordinator", "Technician"];
// send-ticket-approval's: the ticket's technician, or one of these.
export const TICKET_SEND_ROLES = ["Admin", "Coordinator"];
// mail.ts's cap on a send.
export const MAX_RECIPIENTS = 10;
// The default Job detail's Send dialog offers for an assessment.
export const JHA_MESSAGE = "Attached: the signed hazard assessment for the work noted below. Let us know if you have questions.";

// mail.ts's ADDRESS, and common.jsx's emailIn — the two patterns the
// screens already apply, so what passes here passes there.
const ADDRESS = /^[^\s@,;<>"]+@(?:[^\s@,;<>".]+\.)+[a-z]{2,}$/i;
const EMAIL_IN = /[\w.+-]+@[\w-]+\.[\w.-]+/;

export function addressIn(s: unknown): string {
  const m = EMAIL_IN.exec(String(s ?? ""));
  return m ? m[0] : "";
}

// `named`: what the model sent — contact names, or addresses. `people`: the
// contacts on file for the job's client and contractor. `saidByPerson`:
// the person's own turns, joined. Answers the addresses, deduped, or
// throws the words the model should pass on.
export function resolveRecipients(named: unknown, people: Person[], saidByPerson: string): string[] {
  const list = Array.isArray(named) ? named.map(x => String(x ?? "").trim()).filter(Boolean) : [];
  if (!list.length) throw new Error("Who should it go to? Ask the person for a contact's name or an email address.");
  const said = String(saidByPerson ?? "").toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (email: string) => {
    const key = email.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(email); }
  };
  for (const item of list) {
    if (item.includes("@")) {
      if (!ADDRESS.test(item)) throw new Error(`"${item}" is not a valid email address.`);
      if (!said.includes(item.toLowerCase())) {
        throw new Error(`The address ${item} was not typed by the person — ask them to type it, or name a contact on file for this job.`);
      }
      add(item);
      continue;
    }
    const q = item.toLowerCase();
    const exact = people.filter(p => String(p.name ?? "").toLowerCase() === q);
    const hits = exact.length ? exact : people.filter(p => String(p.name ?? "").toLowerCase().includes(q));
    if (!hits.length) {
      throw new Error(`No contact called "${item}" is on file for this job's client or contractor. Ask the person who they mean, or for the address.`);
    }
    if (hits.length > 1) {
      throw new Error(`More than one contact matches "${item}": ${hits.map(h => h.name).join(", ")}. Ask the person which.`);
    }
    const email = String(hits[0].email ?? "").trim();
    if (!email) throw new Error(`${hits[0].name} has no email on file — add one on the Contacts screen, or ask the person for the address.`);
    add(email);
  }
  if (out.length > MAX_RECIPIENTS) throw new Error(`${out.length} addresses; ${MAX_RECIPIENTS} is the limit.`);
  return out;
}

export function jhaSendGate(jha: JhaToSend, me: Me): void {
  if (!jha.pdf_key) throw new Error("This assessment has no PDF yet — render it on Job detail first.");
  if (jha.signed_by !== me.id && !JHA_SEND_ROLES.includes(me.role)) {
    throw new Error("Only the technician who filed this assessment, or a Technician, Coordinator or Admin, can email it.");
  }
}

export function ticketSendGate(t: TicketToSend, me: Me): void {
  if (t.status === "Approved" || t.status === "Invoiced") {
    throw new Error(`Ticket ${t.id} is ${String(t.status).toLowerCase()} — the client has already signed it, so there is nothing to send.`);
  }
  if (!(Number(t.total) > 0)) throw new Error(`Ticket ${t.id} has nothing on it yet, so there is nothing to approve.`);
  if (t.technician_id !== me.id && !TICKET_SEND_ROLES.includes(me.role)) {
    throw new Error(`Ticket ${t.id} is another technician's; only its technician, a Coordinator or an Admin can send it for approval.`);
  }
}

// The viewer's rule: the address in the client contact the ticket was
// raised against, else the job's current client rep.
export function ticketApprovalAddress(contactLine: unknown, fallbackEmail: unknown): string {
  const address = addressIn(contactLine) || String(fallbackEmail ?? "").trim();
  if (!address) throw new Error("No client email on file for this ticket — add a client rep to the job record and it can be sent.");
  return address;
}

// db.js shapeJha's rule for the file's name.
export function jhaFileName(pdfKey: string | null, template: string | null): string {
  if (pdfKey) return pdfKey.split("/").pop() || "jha.pdf";
  return template ? `${template.replace(/\s+/g, "-")}.pdf` : "jha.pdf";
}

export function sendJhaWords(jha: JhaToSend, job: JobName, to: string[]): SendWords {
  const file = jhaFileName(jha.pdf_key, jha.template);
  const day = jha.work_date ? ` (work date ${jha.work_date})` : "";
  const again = jha.sent_at ? " again" : "";
  const list = to.join(", ");
  return {
    summary: `Send the hazard assessment ${file}${day} on ${job.job_number}${again} to ${list}?`,
    done: `Sent ${file} on ${job.job_number} to ${list}.`
  };
}

export function sendTicketWords(t: TicketToSend, job: JobName, to: string[]): SendWords {
  const again = t.status === "Awaiting approval" ? " again" : "";
  const list = to.join(", ");
  return {
    summary: `Send ticket ${t.id} on ${job.job_number} to ${list} for approval${again}? The rep gets a fresh signing link.`,
    done: `Approval request for ${t.id} sent to ${list}.`
  };
}
