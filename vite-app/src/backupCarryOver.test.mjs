// The backup carries unchanged files over on the drive instead of pulling
// them through Supabase every night (docs/superpowers/specs/2026-09-07-…).
// The decisions are pure and live in backupRun.ts; this pins them.
//
// Run with: node --test src/backupCarryOver.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  WRITE_ONCE_BUCKETS, carryOverId, chooseBaseFolder,
  newRunCursor, reviveCursor, pausePage, afterFilesPage, countsOf
} from "../../supabase/functions/_shared/backupRun.ts";
import { BUCKETS } from "../../supabase/functions/_shared/backupTables.ts";
import { fileEntryName } from "../../supabase/functions/_shared/backupManifest.ts";
import { carriedOverNote } from "./backupPanelLogic.js";

test("only buckets whose keys are never reused are carried over", () => {
  // reports keys carry Date.now(); chat-media keys are UUIDs. jhas and
  // timesheets are re-rendered at the same key, and a shared file deleted
  // and re-uploaded has the same key — same name and size would lie.
  assert.deepEqual([...WRITE_ONCE_BUCKETS].sort(), ["chat-media", "reports"]);
  for (const b of WRITE_ONCE_BUCKETS) assert.ok(BUCKETS.includes(b), `${b} is a bucket the backup walks`);
});

test("an object is carried over when the base holds its name at the same size", () => {
  const name = fileEntryName("reports", "S-10113/1787005997347-report.pdf");
  const base = new Map([[name, { id: "drive-42", name, size: 230568, sha256: "a".repeat(64) }]]);
  assert.equal(carryOverId("reports", name, 230568, base), "drive-42");
  // A different size is a different file, whatever the name says.
  assert.equal(carryOverId("reports", name, 230567, base), null);
  // Absent from the base: download it.
  assert.equal(carryOverId("reports", fileEntryName("reports", "S-2/x.pdf"), 10, base), null);
  // A size the listing could not give is no match.
  assert.equal(carryOverId("reports", name, -1, base), null);
  assert.equal(carryOverId("reports", name, NaN, base), null);
});

test("a rewritable bucket is never carried over, even on a perfect match", () => {
  for (const bucket of ["jhas", "timesheets", "shared"]) {
    const name = fileEntryName(bucket, "k.pdf");
    const base = new Map([[name, { id: "drive-1", name, size: 20 }]]);
    assert.equal(carryOverId(bucket, name, 20, base), null, bucket);
  }
});

test("the base is the newest stamped folder that is not this run's own", () => {
  const names = ["2026-09-05 02-00", "before-restore 2026-09-06 03-10", "2026-09-06 02-00", "notes", "2026-09-07 02-00"];
  assert.equal(chooseBaseFolder(names, "2026-09-07 02-00"), "2026-09-06 02-00");
  // The first backup ever has nothing to copy from.
  assert.equal(chooseBaseFolder(["2026-09-07 02-00"], "2026-09-07 02-00"), null);
  assert.equal(chooseBaseFolder([], "2026-09-07 02-00"), null);
  // Only stamps count: an Admin's own folder in the same drive is not a base.
  assert.equal(chooseBaseFolder(["notes", "2026-09-07 02-00"], "2026-09-07 02-00"), null);
});

test("the cursor remembers the base it chose, and that it looked", () => {
  const fresh = newRunCursor("2026-09-07T02:00:00Z");
  assert.equal(fresh.baseLooked, false);
  assert.equal(fresh.baseFilesFolderId, null);
  assert.equal(fresh.reused, 0);
  const revived = reviveCursor({ baseLooked: true, baseFilesFolderId: "f-1", reused: "12" }, "x");
  assert.equal(revived.baseLooked, true);
  assert.equal(revived.baseFilesFolderId, "f-1");
  assert.equal(revived.reused, 12);
  // A cursor from before the field existed looks again, and has reused none.
  const old = reviveCursor({ phase: "files", files: 3 }, "x");
  assert.equal(old.baseLooked, false);
  assert.equal(old.baseFilesFolderId, null);
  assert.equal(old.reused, 0);
});

test("a paused page and a finished page both carry the reused count", () => {
  const c = newRunCursor("x");
  pausePage(c, 4, 4, 400, 3);
  assert.equal(c.files, 4); assert.equal(c.bytes, 400); assert.equal(c.reused, 3);
  c.prefixes = [{ prefix: "", offset: 0 }];
  afterFilesPage(c, { bucketCount: 5, pageLength: 2, pageRows: 100, folderNames: [], files: 2, bytes: 20, reused: 1 });
  assert.equal(c.files, 6); assert.equal(c.bytes, 420); assert.equal(c.reused, 4);
  // And the counts the panel reads say so.
  assert.equal(countsOf(c).reused, 4);
});

test("the panel says how many were carried over, and nothing when none were", () => {
  assert.equal(carriedOverNote({ files: 10, reused: 0 }), "");
  assert.equal(carriedOverNote(null), "");
  assert.equal(carriedOverNote({ files: 6000, reused: 5988 }), ", 5988 carried over from the night before");
});

test("a copy with no recorded hash is not carried over — it is read through and hashed", () => {
  // The night the index shipped, last night's folder has no files.json.gz:
  // every file goes the long way round once, so this folder's index is
  // complete and every night after can copy on the drive and verify.
  const name = fileEntryName("reports", "S-10113/1787005997347-report.pdf");
  const noHash = new Map([[name, { id: "drive-42", name, size: 230568, sha256: null }]]);
  assert.equal(carryOverId("reports", name, 230568, noHash), null);
  const legacy = new Map([[name, { id: "drive-42", name, size: 230568 }]]);
  assert.equal(carryOverId("reports", name, 230568, legacy), null);
});
