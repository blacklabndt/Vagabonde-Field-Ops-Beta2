// "Check my ticket" — what looks off about a draft ticket before it goes to
// the client rep, decided from the rows Ask read as the person. Pure, no
// imports (backupShared.test.mjs guards that); ticketCheck.test.mjs holds
// every finding and the ceilings to data.js's.
//
// The editor asks these questions one at a time as the person types — the
// sane-quantity confirm, the crew-hours confirm, the rep box — and the
// send refuses a $0 total; here they are asked all at once, in plain
// phrases, and nothing is changed. A line the client's card no longer
// offers is NOT checked: the catalog's label expansion is db.js's own.

// Twins of data.js's SANE_QUANTITY_PER_UNIT, SANE_QUANTITY_DEFAULT and
// SANE_CREW_HOURS; ticketCheck.test.mjs reads data.js and fails on drift.
export const SANE_QUANTITY_PER_UNIT: Record<string, number> = { weld: 200, h: 24, days: 31, km: 2000, ea: 200 };
export const SANE_QUANTITY_DEFAULT = 200;
export const SANE_CREW_HOURS = 24;
export const saneQuantityCeiling = (unit: string | null | undefined): number =>
  Object.prototype.hasOwnProperty.call(SANE_QUANTITY_PER_UNIT, unit ?? "") ? SANE_QUANTITY_PER_UNIT[unit ?? ""] : SANE_QUANTITY_DEFAULT;

export interface CheckTicket { id: string; status: string | null; work_date: string | null; client_contact: string | null }
export interface CheckLine { kind: string; label: string; unit: string | null; quantity: unknown; unit_rate: unknown }
export interface CheckCrew { name: string; straight_hours: unknown; ot_hours: unknown; solo_hours: unknown; solo_ot_hours: unknown }
export interface CheckInput { ticket: CheckTicket; lines: CheckLine[]; crew: CheckCrew[]; jhaCount: number; today: string }
export interface TicketCheck { ticket_id: string; findings: string[]; ok: boolean }

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// A line's cents, the way lineTotal / lineCents do it: whole cents times
// thousandths of a unit, so the total here is the trigger's.
const lineCents = (l: CheckLine): number => Math.round(Math.round(num(l.unit_rate) * 100) * Math.round(num(l.quantity) * 1000) / 1000);
const hundredths = (n: number): number => Math.round(n * 100) / 100;

export function ticketCheck({ ticket, lines, crew, jhaCount, today }: CheckInput): TicketCheck {
  const findings: string[] = [];
  if (!String(ticket.client_contact ?? "").trim()) findings.push("no client rep on the ticket — the approval has nowhere to go");
  if (!lines.length) findings.push("no charges on the ticket");
  let cents = 0;
  for (const l of lines) {
    const q = num(l.quantity);
    const unit = l.unit || (l.kind === "weld" ? "weld" : "ea");
    const ceiling = saneQuantityCeiling(unit);
    if (q <= 0) findings.push(`${l.label}: quantity is zero`);
    else if (q > ceiling) findings.push(`${l.label}: ${q} ${unit} is above the editor's ceiling of ${ceiling} — a typo?`);
    if (num(l.unit_rate) <= 0) findings.push(`${l.label} is priced at $0`);
    cents += lineCents(l);
  }
  if (lines.length && cents <= 0) findings.push("the total is $0 — the client would be sent a $0.00 approval");
  if (!crew.length) findings.push("no crew on the ticket — your own hours go here");
  else {
    let any = 0;
    for (const c of crew) {
      const paid = hundredths(num(c.straight_hours) + num(c.ot_hours));
      const solo: [number, string][] = [[num(c.solo_hours), "solo"], [num(c.solo_ot_hours), "solo OT"]];
      any += paid + solo[0][0] + solo[1][0];
      if (paid > SANE_CREW_HOURS) findings.push(`${c.name}: ${paid} hours on one day — a typo?`);
      for (const [value, label] of solo) {
        if (value > SANE_CREW_HOURS) findings.push(`${c.name}: ${value} ${label} hours on one day — a typo?`);
      }
    }
    if (any <= 0) findings.push("no hours entered for the crew");
  }
  if (ticket.work_date && jhaCount <= 0) findings.push(`no JHA filed on the job for ${ticket.work_date}`);
  if (ticket.work_date && ticket.work_date > today) findings.push(`the work date ${ticket.work_date} is in the future`);
  return { ticket_id: ticket.id, findings, ok: findings.length === 0 };
}
