# The backup knows the hash of every file it holds

Date: 8 September 2026. Follows
`2026-09-07-backup-carries-unchanged-files-over-design.md`.

## The question

Since 7 September a file in a write-once bucket whose name and size last
night's folder already held is copied on the drive rather than read through
Supabase. Kyle asked whether anything checks that those copies — or any
stored file — are still the bytes that were backed up. Nothing did. The
carry-over matched on name and size; the manifest recorded a count, a byte
total and how many were reused; a restore wrote files back as they came.
The table parts are gzipped and gzip carries its own CRC, so a damaged part
fails at restore time; a damaged PDF went back over a good one in silence.

## What changes

1. **Every stored file is hashed as it is read through Supabase.** The
   files phase computes SHA-256 over the bytes it uploads and records, per
   file, the entry name, bucket, key, size, hash, whether it was carried
   over, and the drive's id for it. Those records live in a new table,
   `backup_run_files` (one row per file per run, service role only,
   deleted with the run), because the files phase spans many slices and the
   manifest is written by the last of them — the cursor is rewritten after
   every unit and cannot carry thousands of entries, and a drive file
   cannot be appended to.
2. **The manifest phase writes `files.json.gz` beside `manifest.json`**: the
   run's records, gzipped. `manifest.files` gains `hashed` (how many carry a
   hash), `index` (the file's name) and `spot` (below). Every folder stays
   complete on its own.
3. **A carried-over file keeps the hash of the copy it was made from**, read
   from last night's `files.json.gz`. A file the base's index does not hold
   is read through instead, once: a copy nothing could ever verify is not a
   saving worth having. The first night after this ships therefore reads
   every file through, the way the carry-over's own first night did, and
   from the second night the copies resume with hashes attached.
4. **One carried-over file a night is spot-checked**: downloaded off the
   drive, hashed, compared with its record. The copy is the provider's and
   never passes through the function, so this is the one thing that would
   notice the drive's own copy drifting. The pick rotates through the
   reused files by day. A mismatch is read through from Supabase again,
   re-stored under the same name, and its record updated before the index
   is written. The outcome is a sentence on the manifest and on the run's
   counts (`spot`): "ok: …", "re-stored: …", "nothing carried over to
   check", or "not checked: …". It never fails the run.
5. **A restore verifies every file it puts back** against the folder's
   index. A file whose bytes do not hash to its record is not written back
   — a damaged PDF over a good one is worse than a missing one — and is
   counted (`damaged`) and named in the run's notes, for both the
   restore-all and the per-job restore. A folder from before the index
   existed has no records and its files go back unchecked, as before.

## What does not change

The carry-over's own rules (write-once buckets only, the base chosen once
per run and never the run's own folder, fall back to download-and-upload on
a failed copy), retention, the safety copy, the tick, and the wipe. The
provider's own per-file hashes (Google's MD5, Graph's quickXorHash,
Dropbox's content hash) are not used: three algorithms, one of them not
available to this runtime, for a check the nightly spot check and the
restore-time hash already make.

## Egress

Unchanged in the steady state: hashing happens on bytes the function is
reading anyway, and the spot check downloads one file a night. The first
night reads everything through once.
