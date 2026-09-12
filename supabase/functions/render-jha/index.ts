// render-jha — draws the filed FLHA as a PDF and files it in Storage.
//
// The layout follows GS-0113-25-01 (the company's own form): identification
// band, site information, the two nuclear energy workers with their dosimetry,
// the equipment record, then the hazard worksheet with its severity /
// probability / frequency ratings.
//
// Drawn with pdf-lib rather than rendered from HTML: Supabase Edge functions
// have no headless browser, and a hand-laid grid matches a form built on a
// grid more faithfully than reflowed HTML would anyway.
//
// Called twice in a JHA's life — when it is filed, and again when it is closed
// out with the end readings — so the stored PDF always reflects the row. The
// second render overwrites the first at the same key (upsert).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";
import type { PDFFont, RGB } from "https://esm.sh/pdf-lib@1.17.1";
import { refuse, publicWords, loggedWords } from "../_shared/publicError.ts";

// Inlined rather than imported from ../_shared: the dashboard's editor deploys
// a single file, and a relative import fails to bundle there.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// The assessment as the read below returns it, and the JSON the builder
// (vite-app/src/components/jhaMobile.jsx: BLANK_SITE, BLANK_EQUIP, the
// dosimetry rows, SEED_HAZARDS) writes into its three JSON columns. Every
// field is optional: a row from before a field existed still draws.
interface JobEmbed {
  job_number?: string | null; project?: string | null; lsd?: string | null; afe?: string | null;
  clients?: { name?: string | null } | null; contractors?: { name?: string | null } | null;
}
interface JhaSite {
  weather?: string | null; temperature?: string | null; communication?: string | null;
  commOther?: boolean | null; muster?: string | null; hospital?: string | null; firstAid?: string | null;
}
interface JhaEquipment {
  ppe?: { hardHat?: boolean; glasses?: boolean; boots?: boolean; fr?: boolean; gloves?: boolean } | null;
  h2sSerial?: string | null; h2sBumpTest?: boolean | null;
  redSerial?: string | null; redSurveyMr?: string | number | null;
  collimator?: boolean | null; emergencyKit?: boolean | null;
}
interface JhaDetails { site?: JhaSite | null; equipment?: JhaEquipment | null }
interface JhaWorker {
  slot?: number | null; name?: string | null; unit?: string | null; idCode?: string | null;
  tld?: string | null; drd?: string | null; alarm?: string | null;
  endReading?: number | string | null; doseMr?: number | string | null;
}
interface JhaHazard {
  name?: string | null; control?: string | null;
  rating?: { s?: number | null; p?: number | null; f?: number | null } | null;
}
interface JhaRow {
  id: string; template: string | null; hazards: unknown; dosimetry: unknown; details: JhaDetails | null;
  unit_number: string | null; site_rep: string | null; signed_at: string | null; work_date: string | null;
  status: string | null; closed_at: string | null; pdf_key: string | null;
  jobs: JobEmbed | null; profiles: { name?: string | null } | null;
}
// What a drawn line may be told besides its words and its place.
interface TextOptions { size?: number; bold?: boolean; color?: RGB }

const PAGE = { w: 612, h: 792 };
const M = 26;                       // page margin
const INK = rgb(0.114, 0.122, 0.125);       // --color-text
const ACCENT = rgb(0.349, 0.502, 0.651);    // --color-accent
const MUTED = rgb(0.42, 0.43, 0.44);
const LINE = rgb(0.78, 0.79, 0.80);

// VagaboNDE wordmark (transparent PNG, 640\u00d7123), baked in as base64.
const LOGO_PNG_B64 = "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";

const TROUBLE = "The assessment PDF could not be built. Try again, and tell the office if it keeps happening.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Who is asking comes before anything is read from them: the parse below
  // throws on a malformed body, and the catch at the bottom writes that to
  // function_errors — a log an anonymous POST must not be able to fill.
  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: "Not signed in" }), {
    status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
  });

  try {
    const { jhaId } = await req.json();
    if (!jhaId) throw refuse("This request didn't say which hazard assessment to render. Reload the app and try again.");

    // Read as the caller: whatever RLS lets them see, they can render.
    const { data: jha, error } = await asUser
      .from("jhas")
      .select("id, template, hazards, dosimetry, details, unit_number, site_rep, signed_at, work_date, status, closed_at, pdf_key, jobs(job_number, project, lsd, afe, clients(name), contractors(name)), profiles(name)")
      .eq("id", jhaId).single();
    if (error || !jha) throw refuse("That hazard assessment couldn't be found, or you don't have access to it.");
    // supabase-js types the embeds of that read as lists; this is the row's
    // real shape.
    const row = jha as unknown as JhaRow;

    const bytes = await drawJha(row);

    // Written with the service role: the bucket is private, and the caller
    // needs read access to the file, not write access to the bucket.
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const job: JobEmbed = row.jobs ?? {};
    // Job numbers are free text. Storage keys are not: # and ? truncate the
    // key, % breaks the request, non-ASCII is refused outright. Same
    // folding as storageKeySafe in vite-app/src/data.js.
    const safe = keySafe(job.job_number, "job");
    const key = row.pdf_key || `${safe}/${safe}-JHA-${jhaId}.pdf`;

    const { error: upErr } = await admin.storage.from("jhas")
      .upload(key, bytes, { contentType: "application/pdf", upsert: true });
    if (upErr) throw refuse("The PDF could not be filed — nothing was saved. Try again.", upErr.message);

    // Record where it was filed. A failure here is said, not swallowed (see
    // send-jha): the PDF is in the bucket, but a row with no pdf_key is a
    // JHA the app cannot open, cannot attach and will re-render to a fresh
    // key next time — and answering ok:true would hide all of that behind a
    // green tick.
    if (key !== row.pdf_key) {
      const { error: markErr } = await admin.from("jhas").update({ pdf_key: key }).eq("id", jhaId);
      if (markErr) {
        throw refuse("The PDF was filed, but the assessment couldn't be pointed at it — it will still show as having no PDF. Try again.", markErr.message);
      }
    }

    return new Response(JSON.stringify({ ok: true, pdfKey: key }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    // The office reads everything; the person reads only what was written
    // for them. See _shared/publicError.ts for why the default is masking.
    await logError("render-jha", loggedWords(e));
    return new Response(JSON.stringify({ error: publicWords(e, TROUBLE) }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}

async function drawJha(jha: JhaRow): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - M;

  const job: JobEmbed = jha.jobs ?? {};
  const client = job.clients?.name ?? "";
  const contractor = job.contractors?.name ?? "";
  // The day the assessment covers, which is what this document is dated. It
  // is not always the day the record was created — a JHA missed on site and
  // written up afterwards carries the day it was for. When it was actually
  // entered is printed separately, as "Filed", further down.
  // Rows predating work_date fall back to the filing timestamp, which for
  // those is the same day.
  const assessmentDate = fmtDay(jha.work_date) || fmtDate(jha.signed_at);
  const details: JhaDetails = jha.details ?? {};
  const site: JhaSite = details.site ?? {};
  const eq: JhaEquipment = details.equipment ?? {};
  const ppe: NonNullable<JhaEquipment["ppe"]> = eq.ppe ?? {};
  const workers: JhaWorker[] = Array.isArray(jha.dosimetry) ? jha.dosimetry : [];
  const hazards: JhaHazard[] = Array.isArray(jha.hazards) ? jha.hazards : [];

  // ── drawing helpers ────────────────────────────────────────────────
  const W = PAGE.w - M * 2;

  // Deliberately no maxWidth. pdf-lib treats it as a wrap width, not a clip:
  // the overflow is drawn on the lines BELOW, straight through whatever the
  // next row of this hand-laid grid put there. Every caller that has text
  // wider than its column runs it through wrapLines first and draws the
  // lines itself, so the layout knows how tall it has become.
  const text = (s: string, x: number, yy: number, o: TextOptions = {}) =>
    page.drawText(foldAscii(s), {
      x, y: yy, size: o.size ?? 8, font: o.bold ? bold : font,
      color: o.color ?? INK
    });

  const rule = (yy: number, x = M, w = W) =>
    page.drawLine({ start: { x, y: yy }, end: { x: x + w, y: yy }, thickness: 0.6, color: LINE });

  // A section header: accent rule with the title sitting on it.
  const section = (title: string) => {
    y -= 14;
    page.drawRectangle({ x: M, y: y - 2, width: W, height: 12, color: rgb(0.93, 0.94, 0.95) });
    text(title.toUpperCase(), M + 4, y + 1, { size: 7.5, bold: true, color: ACCENT });
    y -= 6;
  };

  // The value of a cell, split into the lines it actually needs. Measured
  // before the row draws so the row can make room for them.
  const cellLines = (value: string, w: number) => wrapLines(value || "—", w - 4, font, 8.5);

  // Label above value, in a cell of the given width. A long project name or
  // hospital address used to be handed to pdf-lib as a maxWidth, which wrapped
  // it down over the row beneath — the LSD printed through the muster point.
  const cell = (label: string, value: string, x: number, yy: number, w: number) => {
    text(label.toUpperCase(), x, yy, { size: 6, color: MUTED });
    cellLines(value, w).forEach((ln, i) => { text(ln, x, yy - 10 - i * 10, { size: 8.5 }); });
  };

  // A row of cells across the page, evenly split. Its height is the tallest
  // cell's, so a value that wraps pushes what follows down the page instead
  // of printing through it. One line comes to exactly the old fixed 24.
  const row = (cells: [string, string][], h = 24) => {
    const w = W / cells.length;
    const lines = Math.max(1, ...cells.map(([, v]) => cellLines(v, w).length));
    const need = Math.max(h, 14 + lines * 10);
    pageBreakIfNeeded(need);
    cells.forEach(([l, v], i) => { cell(l, v, M + 4 + i * w, y, w); });
    y -= need;
  };

  const checkbox = (on: boolean, label: string, x: number, yy: number) => {
    page.drawRectangle({ x, y: yy - 7, width: 8, height: 8, borderWidth: 0.8, borderColor: INK });
    if (on) {
      page.drawLine({ start: { x: x + 1.5, y: yy - 3 }, end: { x: x + 3.5, y: yy - 6 }, thickness: 1.2, color: ACCENT });
      page.drawLine({ start: { x: x + 3.5, y: yy - 6 }, end: { x: x + 7, y: yy + 0.5 }, thickness: 1.2, color: ACCENT });
    }
    text(label, x + 12, yy - 6, { size: 8 });
  };

  const pageBreakIfNeeded = (need: number) => {
    if (y - need > M + 24) return;
    footer();
    page = doc.addPage([PAGE.w, PAGE.h]);
    y = PAGE.h - M;
  };

  const footer = () => {
    rule(M + 16);
    text("GS-0113-25-01  ·  Field Level Hazard Assessment  ·  VagaboNDE Inc.", M, M + 6, { size: 6.5, color: MUTED });
    // One line, always: a footer has nothing below it but the paper's edge,
    // so a wrapped second line would print off the bottom of the sheet.
    const foot = `${job.job_number ?? ""} · ${assessmentDate}`;
    text(wrapLines(foot, 150, font, 6.5)[0] ?? "", PAGE.w - M - 150, M + 6, { size: 6.5, color: MUTED });
  };

  // ── identification band ────────────────────────────────────────────
  // The wordmark is a static asset baked in as base64 rather than fetched \u2014
  // Edge Functions have no project filesystem to read it from at runtime.
  const logoBytes = Uint8Array.from(atob(LOGO_PNG_B64), c => c.charCodeAt(0));
  const logo = await doc.embedPng(logoBytes);
  const logoW = 96, logoH = logoW * (logo.height / logo.width);
  page.drawImage(logo, { x: M, y: y - logoH + 4, width: logoW, height: logoH });
  text("FIELD LEVEL HAZARD ASSESSMENT", M + logoW + 10, y - 22, { size: 9, bold: true, color: ACCENT });
  // Both fixed strings, and both fit their corner of the band at 8pt.
  text("GS-0113-25-01", PAGE.w - M - 90, y - 10, { size: 8, color: MUTED });
  text(jha.status === "Closed" ? "CLOSED" : "OPEN — awaiting end readings",
    PAGE.w - M - 150, y - 22, { size: 8, bold: true, color: jha.status === "Closed" ? MUTED : ACCENT });
  y -= 32;
  rule(y);
  y -= 6;

  row([["Client", client], ["Work location", job.lsd ?? ""], ["Unit #", jha.unit_number ?? ""], ["Date", assessmentDate]]);
  row([["Job #", job.job_number ?? ""], ["Project", job.project ?? ""], ["Contractor", contractor], ["AFE", job.afe ?? ""]]);

  // ── site information ───────────────────────────────────────────────
  section("Site information");
  row([["Weather", site.weather ?? ""], ["Temperature", site.temperature ?? ""], ["Communication", site.communication ?? ""]]);
  row([["Muster point", site.muster ?? ""], ["First aid attendant", site.firstAid ?? ""]]);
  // Full page width, and it grows with the address the same way a row does.
  cell("Nearest hospital", site.hospital ?? "", M + 4, y, W);
  y -= Math.max(24, 14 + cellLines(site.hospital ?? "", W).length * 10);

  // ── dosimetry ──────────────────────────────────────────────────────
  section("Nuclear energy worker dosimetry");
  const cols = [
    { t: "Worker", w: 116 }, { t: "ID code", w: 62 }, { t: "Unit #", w: 44 },
    { t: "TLD / OSLD", w: 74 }, { t: "DRD", w: 66 }, { t: "Alarm", w: 62 },
    { t: "Start", w: 34 }, { t: "End", w: 34 }, { t: "Dose mR", w: 48 }
  ];
  y -= 4;
  let cx = M + 2;
  cols.forEach(c => { text(c.t.toUpperCase(), cx, y, { size: 6, color: MUTED }); cx += c.w; });
  y -= 4;
  rule(y);
  y -= 12;
  if (!workers.length) {
    text("No workers recorded on this assessment.", M + 2, y, { size: 8, color: MUTED });
    y -= 14;
  }
  workers.forEach(w => {
    const vals = [
      `(${w.slot}) ${w.name ?? ""}`, w.idCode ?? "", w.unit ?? "", w.tld ?? "", w.drd ?? "", w.alarm ?? "",
      "0", w.endReading == null ? "—" : String(w.endReading), w.doseMr == null ? "—" : String(w.doseMr)
    ];
    // Split before anything is drawn, so the row knows its own height. A long
    // name in a 116pt column is the common case; handing it to pdf-lib as a
    // maxWidth wrapped it down over the next worker's dose figures.
    const wrapped = vals.map((v, i) => wrapLines(String(v), cols[i].w - 3, font, 8));
    const tall = Math.max(1, ...wrapped.map(l => l.length));
    // Defensive rather than a fix for anything seen: a crew is two or
    // three people and it would take about thirty-five to reach the foot
    // of the page. But this is a dose record, and a row that runs off the
    // sheet is not a row anybody notices is missing.
    pageBreakIfNeeded(6 + tall * 10 + 6);
    cx = M + 2;
    wrapped.forEach((lines, i) => {
      lines.forEach((ln, k) => { text(ln, cx, y - k * 10, { size: 8, bold: i === 8 && w.doseMr != null }); });
      cx += cols[i].w;
    });
    y -= 4 + tall * 10;
  });
  text("Start reading is 0 on every assessment; the end reading is the dose recorded for that worker.",
    M + 2, y, { size: 6.5, color: MUTED });
  y -= 10;

  // ── equipment record ───────────────────────────────────────────────
  section("Equipment record");
  y -= 6;
  const ppeItems: [string, boolean][] = [
    ["Hard hat", !!ppe.hardHat], ["Safety glasses", !!ppe.glasses], ["Steel toe boots", !!ppe.boots],
    ["FR coveralls", !!ppe.fr], ["Gloves", !!ppe.gloves]
  ];
  let px = M + 4;
  ppeItems.forEach(([l, on]) => { checkbox(on, l, px, y); px += 108; });
  y -= 20;
  row([["H₂S monitor s/n", eq.h2sSerial ?? ""], ["Bump test", eq.h2sBumpTest ? "Yes" : "No"],
       ["Exposure device s/n", eq.redSerial ?? ""], ["Surface survey", eq.redSurveyMr ? `${eq.redSurveyMr} mR/h` : ""]]);
  px = M + 4;
  [["Collimator available", !!eq.collimator], ["Emergency equipment on hand", !!eq.emergencyKit]]
    .forEach(([l, on]) => { checkbox(on as boolean, l as string, px, y); px += 200; });
  y -= 18;
  // No warning line under the survey: the reading is recorded, not judged —
  // the screen dropped its own warning for the same reason, and the document
  // the contractor receives has to say what the screen says.

  // ── hazard worksheet ───────────────────────────────────────────────
  pageBreakIfNeeded(120);
  section("Hazard worksheet");
  y -= 4;
  const hCols = [{ t: "Hazard", w: 150 }, { t: "Control", w: 232 }, { t: "Sev", w: 26 }, { t: "Prob", w: 28 }, { t: "Freq", w: 28 }, { t: "Priority", w: 76 }];
  cx = M + 2;
  hCols.forEach(c => { text(c.t.toUpperCase(), cx, y, { size: 6, color: MUTED }); cx += c.w; });
  y -= 4;
  rule(y);
  y -= 12;

  hazards.forEach(h => {
    // Room for however many lines this particular control wraps to,
    // rather than a fixed 30 that assumed one or two.
    pageBreakIfNeeded(23 + wrapLines(String(h.control ?? ""), hCols[1].w - 4, font, 8).length * 10);
    const r = h.rating ?? {};
    const total = (r.s ?? 0) + (r.p ?? 0) + (r.f ?? 0);
    const band = total === 0 ? "—" : total <= 5 ? "Low" : total <= 7 ? "Medium" : "High";
    cx = M + 2;
    // pdf-lib actually wraps text itself when maxWidth is passed (it does not
    // just clip), so a long control string drew its own wrapped line AND the
    // manual second line below duplicated it on top. Splitting by hand first,
    // and never handing pdf-lib a string wider than the column, avoids that.
    const ctrl = wrapLines(String(h.control ?? ""), hCols[1].w - 4, font, 8);
    const vals = [
      h.name ?? "", ctrl[0] ?? "", r.s ?? "—", r.p ?? "—", r.f ?? "—",
      total ? `${total} · ${band}` : "—"
    ];
    vals.forEach((v, i) => { text(String(v), cx, y, { size: 8 }); cx += hCols[i].w; });
    y -= 13;
    // Continuation lines sit under the Control column only, so the ratings
    // beside them stay legible however long the control runs.
    for (const extra of ctrl.slice(1)) {
      text(extra, M + 2 + hCols[0].w, y + 3, { size: 8 });
      y -= 10;
    }
  });
  text("Severity, probability and frequency are rated 1–3. Priority is their sum: 3–5 low, 6–7 medium, 8–9 high.",
    M + 2, y - 2, { size: 6.5, color: MUTED });
  y -= 16;

  // ── review ─────────────────────────────────────────────────────────
  pageBreakIfNeeded(70);
  section("Review");
  row([["Filed by", jha.profiles?.name ?? ""], ["Filed", fmtStamp(jha.signed_at)],
       ["Site rep", jha.site_rep ?? ""], ["Closed out", jha.closed_at ? fmtStamp(jha.closed_at) : "—"]]);
  // Wider than the sheet, so it wraps by hand like everything else here.
  wrapLines("Filed electronically through VagaboNDE Field Ops. The account filing this assessment is the record of who completed it; no handwritten signature is collected.",
    W - 8, font, 7).forEach((ln, i) => { text(ln, M + 4, y - i * 9, { size: 7, color: MUTED }); });

  footer();
  return await doc.save();
}

// Splits text into [first line that fits width, remaining words] by hand —
// pdf-lib wraps on its own when handed a maxWidth wider than the text, so
// callers pass it pre-fitted single lines instead and never lean on that.
// Wraps to as many lines as the text needs.
//
// This used to return exactly two — a first line and "everything else" — and
// the caller drew that remainder without a maxWidth, so a control running past
// about two lines went straight across the severity, probability and frequency
// columns. Nothing on file is that long today (the longest is 81 characters),
// but hazard controls are free text in the JHA builder, and a regulatory
// document that silently prints one field over another is not one to leave to
// chance.
// The standard PDF fonts are WinAnsi-only, so anything outside Latin-1 —
// H₂S, °C, curly quotes, en dashes, ≤ — throws instead of drawing. Field
// text arrives from the app and from typed notes, so every string is folded
// to an encodable equivalent before it is drawn OR measured. Module scope so
// the draw path (foldAscii in drawText) and the wrap path (wrapLines below)
// size the identical string — several folds expand a glyph (≤ → "<=",
// ⁰¹²³ → "0123"), so measuring the raw form under-counts and a hazard
// control could silently overprint the Sev/Prob/Freq columns.
// The storage-key half of storageKeySafe in vite-app/src/data.js: accents
// fold to plain letters, everything else the key can't carry becomes a dash.
function keySafe(name: unknown, fallback: string): string {
  const cleaned = String(name || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
  return cleaned || fallback;
}

function foldAscii(s: string): string {
  return String(s ?? "")
    .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, c => "0123456789"[" ₀₁₂₃₄₅₆₇₈₉".indexOf(c) - 1])
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, c => "0123456789"["⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(c)])
    .replace(/[’‘‚‛]/g, "'").replace(/[“”„‟]/g, '"')
    .replace(/[–—―]/g, "-").replace(/…/g, "...")
    .replace(/≤/g, "<=").replace(/≥/g, ">=").replace(/≈/g, "~").replace(/×/g, "x")
    .replace(/[   ]/g, " ")
    .replace(/[^\x20-\xFF]/g, "");
}

function wrapLines(s: string, width: number, font: PDFFont, size: number): string[] {
  if (!s) return [];
  const out: string[] = [];
  let line = "";
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const next = line ? line + " " + word : word;
    // Measured on the folded form — the exact string foldAscii will draw —
    // so an expanding fold can't push the drawn line past the column.
    if (line && font.widthOfTextAtSize(foldAscii(next), size) > width) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

// A plain calendar date (YYYY-MM-DD) has no time and no zone, so it must not
// be put through Date parsing — "2026-08-12" parsed as UTC midnight renders as
// the 11th anywhere west of Greenwich, which is where every crew is.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (day: string | null | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? "");
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
};

// A real timestamp, unlike fmtDay above, so it must be told which zone to
// land in: this function runs in UTC, and an assessment filed at half past
// six on a Grande Prairie evening printed the next day's date on a document
// the crew signs against the shift they worked. _shared/invoice.ts pins the
// same zone in edmontonStamp for the invoice side, but render-jha
// deploys as a single file (see the corsHeaders note at the top) and cannot
// import it.
const EDMONTON = "America/Edmonton";
const fmtDate = (ts: string | null | undefined) => {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(+d) ? "" : d.toLocaleDateString("en-CA", { timeZone: EDMONTON, day: "2-digit", month: "short", year: "numeric" });
};
// The year rides along: a hazard assessment is kept for years, and "02 Sep,
// 18:30" on a filed record does not say which September.
const fmtStamp = (ts: string | null | undefined) => {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(+d) ? "" : d.toLocaleString("en-CA", { timeZone: EDMONTON, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};
