// Who a send Ask proposes may go to, and the gates the screens apply:
// names resolve to contacts on file with an email, a bare address only when
// the person typed it, and the JHA and ticket gates refuse in the
// functions' own words.

import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveRecipients, jhaSendGate, ticketSendGate, ticketApprovalAddress, jhaFileName,
  sendJhaWords, sendTicketWords, addressIn, MAX_RECIPIENTS, JHA_SEND_ROLES, TICKET_SEND_ROLES
} from "../../supabase/functions/_shared/askSends.ts";

const PEOPLE = [
  { id: "p1", name: "Dave Beaudry", email: "dave@pembina.com", org_type: "client" },
  { id: "p2", name: "Terry Beaudry", email: "t.beaudry@pembina.com", org_type: "client" },
  { id: "p3", name: "Mo Singh", email: "", org_type: "contractor" },
  { id: "p4", name: "Ann Lee", email: "ann@contractor.ca", org_type: "contractor" }
];
const JOB = { id: "j1", job_number: "S-10113" };

test("a name resolves to the one contact on file, exact first, then by containment", () => {
  assert.deepEqual(resolveRecipients(["Dave Beaudry"], PEOPLE, ""), ["dave@pembina.com"]);
  assert.deepEqual(resolveRecipients(["dave beaudry"], PEOPLE, ""), ["dave@pembina.com"]);
  assert.deepEqual(resolveRecipients(["Ann"], PEOPLE, ""), ["ann@contractor.ca"]);
  assert.deepEqual(resolveRecipients(["Dave", "Ann Lee"], PEOPLE, ""), ["dave@pembina.com", "ann@contractor.ca"]);
});

test("unknown, ambiguous and no-email names refuse, naming the person", () => {
  assert.throws(() => resolveRecipients(["Bob"], PEOPLE, ""), /No contact called "Bob"/);
  assert.throws(() => resolveRecipients(["Beaudry"], PEOPLE, ""), /More than one contact matches "Beaudry": Dave Beaudry, Terry Beaudry/);
  assert.throws(() => resolveRecipients(["Mo Singh"], PEOPLE, ""), /Mo Singh has no email on file/);
  assert.throws(() => resolveRecipients([], PEOPLE, ""), /Who should it go to/);
  assert.throws(() => resolveRecipients("Dave", PEOPLE, ""), /Who should it go to/);
});

test("a bare address passes only when the person typed it, case-insensitively", () => {
  assert.deepEqual(resolveRecipients(["joe@acme.ca"], PEOPLE, "send it to Joe@Acme.ca please"), ["joe@acme.ca"]);
  assert.throws(() => resolveRecipients(["joe@acme.ca"], PEOPLE, "send it to joe"), /joe@acme.ca was not typed by the person/);
  // An address off a record the model read is not the person's words.
  assert.throws(() => resolveRecipients(["dave@pembina.com"], PEOPLE, "send it to dave"), /was not typed by the person/);
  assert.throws(() => resolveRecipients(["not an address@"], PEOPLE, "not an address@"), /is not a valid email address/);
});

test("addresses are deduped and capped at the transport's limit", () => {
  assert.deepEqual(resolveRecipients(["Dave Beaudry", "dave@pembina.com", "DAVE@pembina.com"], PEOPLE, "dave@pembina.com"), ["dave@pembina.com"]);
  const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `p${i}@x.ca`);
  assert.throws(() => resolveRecipients(many, PEOPLE, many.join(" ")), /11 addresses; 10 is the limit/);
  assert.equal(resolveRecipients(many.slice(0, MAX_RECIPIENTS), PEOPLE, many.join(" ")).length, MAX_RECIPIENTS);
});

test("the JHA gate is send-jha's: a PDF, and the signer or a sending role", () => {
  const jha = { id: "a1", signed_by: "u1", pdf_key: "jhas/x.pdf", template: "RT — Shop radiography v1", work_date: "2026-09-08" };
  assert.throws(() => jhaSendGate({ ...jha, pdf_key: null }, { id: "u1", role: "Admin" }), /no PDF yet/);
  assert.doesNotThrow(() => jhaSendGate(jha, { id: "u1", role: "Helper" }));
  assert.throws(() => jhaSendGate(jha, { id: "u2", role: "Helper" }), /Only the technician who filed this assessment/);
  for (const role of JHA_SEND_ROLES) assert.doesNotThrow(() => jhaSendGate(jha, { id: "u2", role }));
});

test("the ticket gate is send-ticket-approval's: unsigned, something on it, own or the office", () => {
  const t = { id: "T-10231", status: "Draft", total: 1250, technician_id: "u1" };
  assert.throws(() => ticketSendGate({ ...t, status: "Approved" }, { id: "u1", role: "Admin" }), /is approved — the client has already signed it/);
  assert.throws(() => ticketSendGate({ ...t, status: "Invoiced" }, { id: "u1", role: "Admin" }), /is invoiced/);
  assert.throws(() => ticketSendGate({ ...t, total: 0 }, { id: "u1", role: "Admin" }), /nothing on it yet/);
  assert.throws(() => ticketSendGate({ ...t, total: null }, { id: "u1", role: "Admin" }), /nothing on it yet/);
  assert.throws(() => ticketSendGate(t, { id: "u2", role: "Technician" }), /another technician's/);
  assert.doesNotThrow(() => ticketSendGate(t, { id: "u1", role: "Technician" }));
  assert.doesNotThrow(() => ticketSendGate({ ...t, status: "Awaiting approval" }, { id: "u1", role: "Technician" }));
  for (const role of TICKET_SEND_ROLES) assert.doesNotThrow(() => ticketSendGate(t, { id: "u2", role }));
});

test("a ticket approval goes to the ticket's contact, else the job's rep, else refuses", () => {
  assert.equal(ticketApprovalAddress("T. Beaudry · (780) 555-0142 · t.beaudry@pembina.com", "rep@x.ca"), "t.beaudry@pembina.com");
  assert.equal(ticketApprovalAddress("T. Beaudry · (780) 555-0142", "rep@x.ca"), "rep@x.ca");
  assert.equal(ticketApprovalAddress(null, "rep@x.ca"), "rep@x.ca");
  assert.throws(() => ticketApprovalAddress("T. Beaudry", ""), /No client email on file for this ticket/);
  assert.equal(addressIn({ name: "x" }), "");
});

test("the words name the file, the job and every address, and say again when it is", () => {
  assert.equal(jhaFileName("jhas/j1/RT-Shop.pdf", "x"), "RT-Shop.pdf");
  assert.equal(jhaFileName(null, "RT — Shop radiography v1"), "RT-—-Shop-radiography-v1.pdf");
  assert.equal(jhaFileName(null, null), "jha.pdf");
  const jha = { id: "a1", signed_by: "u1", pdf_key: "jhas/j1/RT-Shop.pdf", template: "x", work_date: "2026-09-08", sent_at: null };
  const w = sendJhaWords(jha, JOB, ["dave@pembina.com", "ann@contractor.ca"]);
  assert.equal(w.summary, "Send the hazard assessment RT-Shop.pdf (work date 2026-09-08) on S-10113 to dave@pembina.com, ann@contractor.ca?");
  assert.equal(w.done, "Sent RT-Shop.pdf on S-10113 to dave@pembina.com, ann@contractor.ca.");
  assert.match(sendJhaWords({ ...jha, sent_at: "2026-09-09T00:00:00Z" }, JOB, ["a@b.ca"]).summary, /S-10113 again to a@b\.ca/);
  const t = sendTicketWords({ id: "T-10231", status: "Draft", total: 1, technician_id: "u1" }, JOB, ["t@pembina.com"]);
  assert.equal(t.summary, "Send ticket T-10231 on S-10113 to t@pembina.com for approval? The rep gets a fresh signing link.");
  assert.equal(t.done, "Approval request for T-10231 sent to t@pembina.com.");
  assert.match(sendTicketWords({ id: "T-1", status: "Awaiting approval", total: 1, technician_id: "u1" }, JOB, ["t@p.com"]).summary, /for approval again\?/);
});
