// The archive's pure half: the client → month → job layout, file naming,
// the CSV guard, the job text file, and the check of a downloaded zip. Plus
// buildArchive itself against a fake data layer, for the one thing that is
// not about formatting: an archive is only allowed to hold what the server
// answered, because the clear behind it deletes the jobs for real.
//
// IndexedDB before the module: buildArchive reads through the offline cache.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { jobFolderPaths, monthFolderOf, uniqueName, csvCell, jobDetailsText, archiveZipName, verifyZip, buildArchive, mapLimit, archiveDrift } from "./archive.js";
import { makeZip, crc32 } from "./zip.js";
import { OfflineCache } from "./offlineCache.js";

test("jobs file under their client and the month they were raised", () => {
  const paths = jobFolderPaths([
    { id: "S-1004", project: "Pipeline tie-in north", client: "Athabasca Oil", createdAtIso: "2026-08-18T18:00:00Z" },
    { id: "S-1005", project: "Pipeline tie-in: north", client: "Athabasca Oil", createdAtIso: "2026-08-19T18:00:00Z" },
    { id: "S-1006", project: "", client: "", createdAtIso: null, createdAt: "" },
    { id: "S-1007", project: "A".repeat(200), client: "Bold Ironworks", createdAtIso: "2026-01-02T03:00:00Z" }
  ]);
  assert.equal(paths[0], "Athabasca Oil/2026-08/S-1004 - Pipeline tie-in north");
  assert.doesNotMatch(paths[1].split("/")[2], /[:\\?*"<>|]/, "what a filesystem refuses is gone from the job folder");
  assert.equal(paths[2], "No client/Undated/S-1006");
  assert.ok(paths[3].startsWith("Bold Ironworks/"));
  assert.ok(paths[3].split("/")[2].length <= 80, "a long project name is cut, not carried");
  assert.equal(new Set(paths).size, 4);
  // The same job twice can't happen, but the naming survives it anyway.
  const twins = jobFolderPaths([{ id: "S-1", project: "x", client: "C", createdAtIso: "2026-05-01T12:00:00Z" }, { id: "S-1", project: "x", client: "C", createdAtIso: "2026-05-01T12:00:00Z" }]);
  assert.equal(twins[1], twins[0] + " (2)");
});

test("the month comes from the local clock, and falls back sanely", () => {
  // Local midnight on the 1st is the 1st, whatever UTC makes of it.
  const local = new Date(2026, 8, 1, 0, 30).toISOString();
  assert.equal(monthFolderOf({ createdAtIso: local }), "2026-09");
  assert.equal(monthFolderOf({ createdAt: "2025-12-31 20:00" }), "2025-12");
  assert.equal(monthFolderOf({ createdAt: "31 Dec, 20:00" }), "Undated");
});

test("a second file of the same name in one folder is numbered", () => {
  const used = new Map();
  assert.equal(uniqueName(used, "RT report.pdf"), "RT report.pdf");
  assert.equal(uniqueName(used, "RT report.pdf"), "RT report (2).pdf");
  assert.equal(uniqueName(used, "rt REPORT.pdf"), "rt REPORT (3).pdf");
  assert.equal(uniqueName(used, "", "report.pdf"), "report.pdf");
});

test("csv cells are quoted and never formulas", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", now'), '"say ""hi"", now"');
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell(null), "");
});

test("the zip is named for what it holds", () => {
  assert.equal(archiveZipName("year", "2025-01-01", "2025-12-31"), "Archive 2025.zip");
  assert.equal(archiveZipName("range", "2025-01-01", "2025-06-30"), "Archive 2025-01-01 to 2025-06-30.zip");
});

test("the job text file carries the record, the money and the crew", () => {
  const txt = jobDetailsText({
    job: { id: "S-1004", project: "Tie-in", client: "Athabasca Oil", contractor: "Bold Ironworks", lsd: "13-22-047-05 W5M", afe: "AFE-77", status: "Active", createdAt: "2026-08-18", createdBy: "Kyle Keith" },
    record: { clientRep: "T. Beaudry · 780-555-0100", contractorRep: "" },
    tickets: [{
      id: "KK-0818-26-01", workDate: "2026-08-18", status: "Approved", total: 1234.5, tech: "Kyle Keith",
      approvedAt: "2026-08-19T15:00:00Z", approvedBy: "T. Beaudry", sentTo: "t@athabasca.example",
      lines: [{ label: '2" NPS weld', quantity: 3, unit: "ea", unit_rate: 45 }],
      crew: [{ name: "Dave Hill", role: "Helper", straight: 8, ot: 2, solo: 0, soloOt: 0, dose: 1.25, mileage: 120 }],
      invoiceFile: "Invoices/KK-0818-26-01.html"
    }],
    jhas: [{ workDate: "2026-08-18", by: "Kyle Keith", status: "Closed", closedAt: "2026-08-18 17:02", dosimetry: [{ name: "Kyle Keith", doseMr: 1.2 }], archived: "JHAs/S-1004-JHA-1.pdf" }],
    reports: [{ file: "RT report.pdf", welds: "W1, W2", result: "Accept", at: "2026-08-18 18:00", sentAt: "", archived: "" }],
    missing: ["Report RT report.pdf: download failed"],
    notOnFile: ["JHA of 2026-08-17"],
    meta: { at: "2026-09-03 10:00", by: "Kyle Keith", range: "archive of 2026" }
  });
  assert.match(txt, /Job S-1004 · Tie-in/);
  assert.match(txt, /Client: Athabasca Oil · rep T\. Beaudry/);
  assert.match(txt, /AFE \/ PO: AFE-77/);
  assert.match(txt, /KK-0818-26-01 · 2026-08-18 · Approved · \$1,234\.50 before GST · GST \$61\.73 · total \$1,296\.23/);
  assert.match(txt, /Approved by T\. Beaudry on .* \(link sent to t@athabasca\.example\)/);
  assert.match(txt, /2" NPS weld × 3 ea @ \$45\.00 = \$135\.00/);
  assert.match(txt, /Dave Hill \(Helper\) · reg 8 · OT 2 · dose 1\.25 mR · 120 km/);
  assert.doesNotMatch(txt, /Dave Hill.*solo/, "a helper has no solo hours");
  assert.match(txt, /Invoice: Invoices\/KK-0818-26-01\.html/);
  assert.match(txt, /Dosimetry: Kyle Keith 1\.2 mR/);
  assert.match(txt, /PDF: JHAs\/S-1004-JHA-1\.pdf/);
  assert.match(txt, /RT report\.pdf · welds W1, W2 · Accept .* · not sent/);
  assert.match(txt, /PDF: \(not on file\)/);
  assert.match(txt, /NO PDF ON FILE[^\n]*\n  JHA of 2026-08-17/);
  assert.match(txt, /NOT RETRIEVED\n  Report RT report\.pdf: download failed/);
});

// A zip built the way the archive builds one, read back the way the dialog
// reads the downloaded file.
const enc = new TextEncoder();
const entries = [
  { name: "Athabasca Oil/2026-08/S-1004 - Tie-in/Job details.txt", data: enc.encode("VagaboNDE Field Ops · job archive\n") },
  { name: "Athabasca Oil/2026-08/S-1004 - Tie-in/Reports/RT report.pdf", data: new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4, 5]) },
  { name: "README.txt", data: enc.encode("hello") }
];
const manifest = entries.map(e => ({ name: e.name, size: e.data.length, crc: crc32(e.data) }));
const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());

test("the downloaded zip checks out when it is the one that was built", async () => {
  const zip = await bytesOf(makeZip(entries));
  const v = verifyZip(zip, manifest);
  assert.equal(v.ok, true, v.problems.join("; "));
  assert.equal(v.checked, 3);
});

test("a byte changed inside a file is caught", async () => {
  const zip = await bytesOf(makeZip(entries));
  // The stored bytes of the PDF follow its local header; flip one and the
  // directory's CRC no longer matches what the build recorded.
  const marker = zip.findIndex((b, i) => b === 0x25 && zip[i + 1] === 0x50 && zip[i + 2] === 0x44 && zip[i + 3] === 0x46);
  assert.ok(marker > 0);
  // The check reads the directory, so damage the directory's CRC rather
  // than the payload (a stored payload changed after zipping keeps its
  // recorded CRC; the directory is what the check trusts).
  const bad = manifest.map(m => m.name.endsWith(".pdf") ? { ...m, crc: (m.crc ^ 1) >>> 0 } : m);
  const v = verifyZip(zip, bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.problems, ["damaged: Athabasca Oil/2026-08/S-1004 - Tie-in/Reports/RT report.pdf"]);
});

test("a file left out of the download is caught, and so is one that isn't from this build", async () => {
  const zip = await bytesOf(makeZip(entries.slice(0, 2)));
  const v = verifyZip(zip, manifest);
  assert.deepEqual(v.problems, ["missing: README.txt"]);
  const other = await bytesOf(makeZip([...entries, { name: "stray.txt", data: enc.encode("x") }]));
  const w = verifyZip(other, manifest);
  assert.deepEqual(w.problems, ["not from this build: stray.txt"]);
});

// ── buildArchive ─────────────────────────────────────────────────────────
// The data layer is handed in, so a fake one is the whole test rig.

const fakeDb = (over = {}) => ({
  getJobRecord: async () => ({ clientRep: "T. Beaudry" }),
  listJhasForJob: async () => [],
  listReportsForJob: async () => [],
  listTicketsForJob: async () => [{ id: "KK-0818-26-01" }],
  listTicketsForArchive: async ids => new Map(ids.map(id => [id, { id, workDate: "2026-08-18", status: "Approved", total: 1234.5, lines: [] }])),
  listCrewForTickets: async ids => new Map(ids.map(id => [id, []])),
  renderTicketInvoice: async () => "<html>invoice</html>",
  downloadObject: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
  ...over
});
const oneJob = [{ id: "S-1004", dbId: 1, project: "Tie-in", client: "Athabasca Oil", createdAtIso: "2026-08-18T18:00:00Z" }];
const build = (db, jobs = oneJob) => buildArchive({ jobs, mode: "year", from: "2026-01-01", to: "2026-12-31", by: "Kyle Keith", db });
const zipText = async blob => new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
const failedFetch = () => { throw new TypeError("Failed to fetch"); };

test("a complete build says so and holds every job's paperwork", async () => {
  const { blob, summary, manifest } = await build(fakeDb());
  assert.deepEqual(summary.missing, []);
  assert.equal(summary.tickets, 1);
  assert.equal(summary.invoices, 1);
  assert.equal(verifyZip(new Uint8Array(await blob.arrayBuffer()), manifest).ok, true);
});

test("a read the network could not answer is a gap in the archive, not an empty job", async () => {
  // This device remembers this job's tickets from before. Outside the
  // archive that copy is the right answer and the cache serves it...
  await OfflineCache.clear();
  await OfflineCache.put("tickets.1", [{ id: "KK-0818-26-01" }]);
  assert.deepEqual(await OfflineCache.readThrough("tickets.1", failedFetch), [{ id: "KK-0818-26-01" }],
    "the cache really would have answered this");
  OfflineCache.markLive();

  // ...but inside the build it must not be, or the zip would verify, the
  // README would call itself complete, and the clear would delete a ticket
  // that is nowhere in it.
  const { blob, summary } = await build(fakeDb({ listTicketsForJob: () => OfflineCache.readThrough("tickets.1", failedFetch) }));
  assert.equal(summary.tickets, 0);
  assert.equal(summary.missing.length, 1);
  assert.match(summary.missing[0], /^S-1004: .*Failed to fetch/);
  assert.match(await zipText(blob), /NOT RETRIEVED — this archive is not complete/);
});

test("anything served from this device's memory during a build is flagged too", async () => {
  // The second lock: some other read flipping the banner mid-build means the
  // job in hand is not to be trusted either, whatever it returned.
  const db = fakeDb({ listJhasForJob: async () => { OfflineCache.noteServingCached(Date.now()); return []; } });
  try {
    const { summary } = await build(db);
    assert.equal(summary.missing.length, 1);
    assert.match(summary.missing[0], /offline copy/);
  } finally {
    OfflineCache.markLive();
  }
});

test("a ticket read that fails is a gap, not the end of the build", async () => {
  // This was the one await in the loop with nothing around it: a blip on
  // ticket 400 of a year threw away everything read so far. It has to be
  // recorded and stepped over, like a PDF that wouldn't download.
  const jobs = [
    { id: "S-1004", dbId: 1, project: "Tie-in", client: "Athabasca Oil", createdAtIso: "2026-08-18T18:00:00Z" },
    { id: "S-1005", dbId: 2, project: "Lateral", client: "Athabasca Oil", createdAtIso: "2026-08-19T18:00:00Z" }
  ];
  const db = fakeDb({
    listTicketsForArchive: async ids => {
      if (ids[0] === "S-1004-T") throw new Error("Failed to fetch");
      return new Map(ids.map(id => [id, { id, status: "Approved", total: 10, lines: [] }]));
    },
    listTicketsForJob: async dbId => [{ id: `S-100${dbId === 1 ? 4 : 5}-T` }]
  });
  const { summary } = await buildArchive({ jobs, mode: "year", from: "2026-01-01", to: "2026-12-31", db });
  // The second job was still read, and the first job's failure is on record.
  assert.equal(summary.tickets, 1);
  assert.equal(summary.missing.length, 1);
  assert.match(summary.missing[0], /^S-1004: The details of 1 ticket\(s\): Failed to fetch/);
});

test("an invoice that would not render is a named gap, and the ticket is still archived", async () => {
  // The invoice is an Edge Function call per ticket — the likeliest thing in
  // the build to refuse. The ticket's own record still belongs in the zip;
  // what must not happen is the count saying an invoice is in there and the
  // README calling the archive complete, because the clear behind it deletes
  // the ticket for real.
  const { blob, summary } = await build(fakeDb({
    renderTicketInvoice: async () => { throw new Error("the invoice service is unavailable"); }
  }));
  assert.equal(summary.tickets, 1, "the ticket is in the archive");
  assert.equal(summary.invoices, 0, "but nothing is counted as an invoice");
  assert.equal(summary.missing.length, 1);
  assert.match(summary.missing[0], /^S-1004: Invoice KK-0818-26-01: the invoice service is unavailable$/);
  const txt = await zipText(blob);
  assert.match(txt, /NOT RETRIEVED — this archive is not complete/);
  assert.match(txt, /Invoice KK-0818-26-01: the invoice service is unavailable/);
});

test("a report PDF that would not download is a named gap too", async () => {
  const { blob, summary } = await build(fakeDb({
    listReportsForJob: async () => [{ file: "RT report.pdf", pdfKey: "reports/rt.pdf" }],
    downloadObject: async () => { throw new Error("storage said no"); }
  }));
  assert.equal(summary.reports, 0, "nothing was retrieved, so nothing is counted");
  assert.deepEqual(summary.missing, ["S-1004: Report RT report.pdf: storage said no"]);
  const txt = await zipText(blob);
  assert.match(txt, /NOT RETRIEVED — this archive is not complete/);
  assert.match(txt, /Report RT report\.pdf: storage said no/);
});

test("the build records what each job held, for the clear to check against", async () => {
  const db = fakeDb({
    listJhasForJob: async () => [{ workDate: "2026-08-18", pdfKey: "" }],
    listReportsForJob: async () => []
  });
  const { summary } = await build(db);
  assert.deepEqual(summary.jobCounts["1"], { tickets: 1, jhas: 1, reports: 0 });
});

test("a job that has gained work since the build stops the clear", () => {
  const job = { id: "S-1200" };
  const was = { tickets: 3, jhas: 1, reports: 2 };
  assert.equal(archiveDrift(job, was, { ...was }), "");
  assert.equal(archiveDrift(job, was, { ...was, tickets: 4 }),
    "Job S-1200 has gained a ticket since the archive was built — build it again.");
  assert.match(archiveDrift(job, was, { ...was, jhas: 2 }), /gained an assessment/);
  assert.match(archiveDrift(job, was, { ...was, reports: 3 }), /gained a report/);
  // A ticket cancelled in between is not work that would be lost, but the
  // zip and the app no longer agree, and this is the one bulk delete.
  assert.match(archiveDrift(job, was, { ...was, tickets: 2 }), /has lost a ticket/);
  // A job the build never recorded is not one to delete on its word.
  assert.match(archiveDrift(job, undefined, was), /wasn't in the archive that was built/);
});

test("a minted duplicate name never collides with a file really called that", () => {
  // Two "RT report.pdf" and a real "RT report (2).pdf", in both orders: three
  // entries, three names. Two entries under one name made a zip the check
  // could never pass, and the clear behind it refused for ever.
  const forward = new Map();
  const a = ["RT report.pdf", "RT report.pdf", "RT report (2).pdf"].map(n => uniqueName(forward, n));
  assert.equal(new Set(a.map(s => s.toLowerCase())).size, 3, a.join(" | "));
  const backward = new Map();
  const b = ["RT report (2).pdf", "RT report.pdf", "RT report.pdf"].map(n => uniqueName(backward, n));
  assert.equal(new Set(b.map(s => s.toLowerCase())).size, 3, b.join(" | "));
  assert.equal(b[0], "RT report (2).pdf", "the real file keeps its own name");
});

test("mapLimit runs a few at a time and answers in order", async () => {
  let running = 0, peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const out = await mapLimit(items, 4, async i => {
    running++;
    peak = Math.max(peak, running);
    await new Promise(r => setTimeout(r, i % 3));
    running--;
    return i * 2;
  });
  assert.deepEqual(out, items.map(i => i * 2), "the answers keep the input's order");
  assert.equal(peak, 4, "never more than four at once");
  assert.deepEqual(await mapLimit([], 4, async () => 1), [], "nothing to do finishes");
});

test("something that isn't a zip is said to be so", () => {
  const v = verifyZip(enc.encode("this is a text file, not a zip, and long enough to look at"), manifest);
  assert.equal(v.ok, false);
  assert.match(v.reason, /isn't a zip/);
  const cut = verifyZip(new Uint8Array(5), manifest);
  assert.equal(cut.ok, false);
});
