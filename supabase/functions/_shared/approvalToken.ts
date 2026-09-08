// The approval token, at rest.
//
// The link a client rep follows carries a raw 244-bit token. The database
// used to hold that same raw string — and every staff account can read the
// tickets table, so anyone signed in could list the live tokens of every
// ticket awaiting signature and sign a colleague's ticket as "the client".
//
// So the row holds only a SHA-256 of the token, prefixed so a hashed value
// can be told from a raw one at a glance (both are 64 hex characters
// otherwise, and a re-run of the hashing migration would otherwise hash a
// hash). approve-ticket hashes what arrives in the URL and looks that up;
// reading the column is now worthless without the original link.

import type { InvoiceData } from "./invoice.ts";

const PREFIX = "sha256:";

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// What the tickets row stores for a raw token. Mirrors the SQL in migration
// 20260902211209 — 'sha256:' || encode(sha256(convert_to(t, 'UTF8')), 'hex')
// — and the two must agree or every link in every inbox dies.
export async function hashToken(raw: string): Promise<string> {
  return PREFIX + await sha256Hex(raw);
}

// A digest of exactly what the rep is asked to sign for: the charges and the
// day. It rides the approval form as a hidden field, and the POST is refused
// when the ticket no longer matches — so a line edited after the email went
// out cannot be signed for under a page that still showed the old figures.
// Fields are joined with ASCII 31 and records with ASCII 30, which no label
// carries, so "a"+"b1" and "ab"+"1" cannot digest alike.
const FIELD = "\u001f";
const RECORD = "\u001e";

export async function invoiceFingerprint(d: InvoiceData): Promise<string> {
  const lines = (d.lines || [])
    .map(l => [l.kind, l.label, l.unit || "", String(l.quantity), String(l.unit_rate)].join(FIELD))
    .sort();
  // The client's GST rate rides in with the charges: an exemption switched
  // on or off leaves every line untouched and still moves the total the rep
  // is putting their name to. The raw column value, so no import of the
  // invoice module's arithmetic is needed here.
  const gst = String(d.job?.clients?.gst_rate ?? "");
  return sha256Hex([d.ticket.id, d.ticket.work_date || "", d.ticket.delays || "", gst, ...lines].join(RECORD));
}
