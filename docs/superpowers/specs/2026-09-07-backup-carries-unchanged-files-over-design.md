# The backup carries unchanged files over on the drive

Date: 2026-09-07. Approved in conversation by Kyle Keith.

## What this is

Every nightly backup still produces a complete, self-contained folder in
the drive — `manifest.json`, `tables/`, `files/` — that a restore reads on
its own and retention deletes whole. What changes is where the unchanged
bytes come from. For each stored object, the files phase asks whether last
night's folder already holds a file of the same name and size. If it does,
the run asks the drive to copy that file into tonight's folder server-side,
moving nothing through Supabase. Only objects the previous folder lacks are
downloaded and uploaded as before.

## Why

The files phase re-reads every stored object out of Supabase every night.
Monthly egress is therefore the whole store times thirty. At the volume
Kyle expects once live (20+ report PDFs a day, 225 kB each) the store passes
the free plan's 5 GB monthly egress in the second month and Pro's 250 GB
in the fifth, from the backup alone. The bytes never change; only the
folder they sit in does.

## Invariants kept

- A backup folder is complete on its own. The restore's `stepFilesBack`
  lists one folder's `files/` and is untouched.
- Retention deletes whole folders and spares a restore's source by name.
  Untouched. `backup_keep = 1` still works: run N copies from N-1, then
  retention removes N-1, and N is whole.
- The slice budget, `pausePage`/`afterFilesPage`, and the conditional
  writes are as they were. A carried-over file counts as a copied file.
- The backup can never do worse than today: a copy that fails for any
  reason falls back to download-and-upload for that object.

## The rule

An object is carried over only when its key can never be reused, because
"same name, same size in the previous folder" is the whole test:

- `reports` — keys carry `Date.now()`; written once.
- `chat-media` — keys are UUIDs; written once.

Buckets whose keys ARE rewritten in place are copied fresh every night:
`jhas` (render-jha upserts at close-out), `timesheets`
(`<profile>/<period>.pdf`, re-rendered at approval), `shared` (a deleted and
re-uploaded file has the same key). Together about five percent of the
bytes. If that ever matters, the extension is a per-file fingerprint index
written beside the manifest; not built until it earns its place.

## The base folder

Once per run, the first files slice picks the base: the newest stamped
folder in the drive's root other than the run's own (`chooseBaseFolder`,
pure, tested), and looks up its `files/` subfolder. Both ids go on the
cursor so later slices do not look again; "looked and found none" is
recorded too. A partial folder from a failed run is a fine base — every
file present in it is whole (uploads are atomic), and anything missing
falls through to the download path. Each slice lists the base's `files/`
once into a name → {id, size} map (`listFiles` pages; a few calls).

## Provider copies

`DriveClient.copy(fileId, folderId, name)` on all three:

- Google: `POST files/{id}/copy` with `name` and `parents`; clashes in the
  target are deleted first, as `upload` does.
- Dropbox: `files/copy_v2` from path to `<folder>/<name>`; the target is
  deleted first (delete ignores not-found).
- Microsoft Graph: `POST items/{id}/copy` with `parentReference`, `name`
  and `conflictBehavior: replace`; the 202's Location is polled for a
  bounded time. Running out of time is a non-retryable failure, which the
  fallback turns into a download-and-upload.

## Counting and telling

The cursor and `backup_runs.counts` gain `reused`; the manifest's `files`
gains `reused`. `files.count` and `files.bytes` keep their meaning: what is
in the folder. The panel's in-progress and last-run sentences say "N
carried over" when it is not zero.

## Tests

- `backupRun.ts` stays import-free and node-tested: `WRITE_ONCE_BUCKETS`,
  `carryOverId(bucket, name, size, base)`, `chooseBaseFolder(names, own)`,
  cursor revive of the new fields, and `pausePage`/`afterFilesPage`
  carrying `reused`.
- `drive.ts` stays import-free (the erasable-TypeScript guard).
- Live: one backup run by hand after deploy, the folder checked for the
  carried-over files and the panel's sentence.

## Deploy

`backup-run`, `backup-restore` and `backup-oauth` by name (they share the
changed modules), then the app.
