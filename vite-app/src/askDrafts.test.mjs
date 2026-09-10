import test from "node:test";
import assert from "node:assert/strict";
import { JHA_TEMPLATES, SEED_HAZARDS } from "./data.js";
import { pickTemplate, shapeJobDraft, shapeTicketDraft, shapeJhaDraft } from "../../supabase/functions/_shared/askDrafts.ts";

const NAMES = SEED_HAZARDS.map(h => h.name);
const PEMBINA = { id: "c1", name: "Pembina Pipeline" };
const JOB = { id: "j1", job_number: "S-10113", project: "RT on the tie-in", status: "Active" };

test("pickTemplate reads the kind of work out of the words", () => {
  assert.equal(pickTemplate("RT on the 12-inch tie-in", JHA_TEMPLATES), "RT — Pipeline tie-in v4");
  assert.equal(pickTemplate("plant piping", JHA_TEMPLATES), "RT — Facility / plant piping v2");
  assert.equal(pickTemplate("facility", JHA_TEMPLATES), "RT — Facility / plant piping v2");
  assert.equal(pickTemplate("in the shop", JHA_TEMPLATES), "RT — Shop radiography v1");
  assert.equal(pickTemplate("sour service", JHA_TEMPLATES), "RT — Sour service (H₂S) v3");
  assert.equal(pickTemplate("H2S line", JHA_TEMPLATES), "RT — Sour service (H₂S) v3");
  assert.equal(pickTemplate("", JHA_TEMPLATES), JHA_TEMPLATES[0]);
  assert.equal(pickTemplate(undefined, JHA_TEMPLATES), JHA_TEMPLATES[0]);
});

test("a job draft needs the project and the LSD, and says which is missing", () => {
  assert.throws(() => shapeJobDraft({ client_name: "x" }, PEMBINA), /needs a project name and the LSD/);
  assert.throws(() => shapeJobDraft({ project: "RT", lsd: "  " }, PEMBINA), /needs the LSD/);
  assert.throws(() => shapeJobDraft({ lsd: "03-12-071-06W6" }, PEMBINA), /needs a project name/);
});

test("a job draft is the dialog's seed and one sentence", () => {
  const d = shapeJobDraft({
    project: " RT on the  tie-in ", client_name: "pembina", lsd: "03-12-071-06W6", afe: "AFE-778",
    contractor_name: "Ledcor", client_rep: "Dana Reid", job_number: "S-10200"
  }, PEMBINA);
  assert.deepEqual(d.seed, {
    project: "RT on the tie-in", jobNumber: "S-10200", client: "Pembina Pipeline", lsd: "03-12-071-06W6", afe: "AFE-778",
    contractor: "Ledcor", clientRepName: "Dana Reid", contractorRepName: ""
  });
  assert.equal(d.summary, "New job for Pembina Pipeline: RT on the tie-in at 03-12-071-06W6, AFE AFE-778, contractor Ledcor, client rep Dana Reid, number S-10200. Open the form to check it and save.");
  const bare = shapeJobDraft({ project: "RT", client_name: "Pembina Pipeline", lsd: "1-2-3-4" }, PEMBINA);
  assert.equal(bare.seed.jobNumber, "");
  assert.equal(bare.summary, "New job for Pembina Pipeline: RT at 1-2-3-4. Open the form to check it and save.");
});

test("a ticket draft cleans its lines and date", () => {
  const d = shapeTicketDraft({
    work_date: "2026-09-10",
    lines: [{ label: " Standby ", quantity: 2 }, { label: "Mileage", quantity: "40" }, { label: "", quantity: 1 }, { label: "Bad", quantity: 0 }, { label: "Worse", quantity: "x" }, "junk"]
  }, JOB);
  assert.deepEqual(d.seed, { workDate: "2026-09-10", lines: [{ label: "Standby", quantity: 2 }, { label: "Mileage", quantity: 40 }] });
  assert.equal(d.summary, "A ticket on S-10113 (RT on the tie-in) for 2026-09-10 with 2 × Standby, 40 × Mileage. Open the editor to finish it and save.");
  const bare = shapeTicketDraft({ work_date: "tomorrow" }, { id: "j", job_number: "S-1" });
  assert.deepEqual(bare.seed, { workDate: null, lines: [] });
  assert.equal(bare.summary, "A ticket on S-1. Open the editor to finish it and save.");
});

test("a JHA draft keeps only real hazards and string site fields", () => {
  const d = shapeJhaDraft({
    template_words: "tie-in", work_date: "2026-09-11", helper_name: "Sam Lee",
    hazards: ["driving", "Radiation (inc. NORM)", "Dragons", 7],
    site: { weather: "Clear", muster: "the gate", hospital: 42, firstAid: "Yes", bogus: "x" }
  }, JOB, JHA_TEMPLATES, NAMES);
  assert.deepEqual(d.seed, {
    template: "RT — Pipeline tie-in v4", workDate: "2026-09-11", helperName: "Sam Lee",
    suggestedHazards: ["Driving", "Radiation (inc. NORM)"],
    site: { weather: "Clear", muster: "the gate", firstAid: "Yes" }
  });
  assert.equal(d.summary, "A JHA on S-10113 (RT on the tie-in), RT — Pipeline tie-in v4, for 2026-09-11, helper Sam Lee, suggesting Driving, Radiation (inc. NORM). Open the builder, tick the hazards that apply, and file it.");
  const bare = shapeJhaDraft({}, { id: "j", job_number: "S-1" }, JHA_TEMPLATES, NAMES);
  assert.deepEqual(bare.seed, { template: JHA_TEMPLATES[0], workDate: null, helperName: "", suggestedHazards: [], site: {} });
});
