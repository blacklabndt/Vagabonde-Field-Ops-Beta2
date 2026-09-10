# The backup checks every file once a fortnight

Date: 8 September 2026. Follows
`2026-09-08-backup-hashes-every-file-design.md`.

## The ask

With every stored file hashed and one carried-over file spot-checked a
night, Kyle asked for a full pass: every so often, hash every file in the
backup and repair from the app whatever has gone wrong.

## The run

A new run kind, `verify`, queued by the tick when `backup_verify_next_at`
falls due — only when no backup is due, so it always runs behind the
backups — and worked in the same 100-second slices, under the same claim,
heartbeat and catch as a backup slice. It makes no folder. The due time
moves when the run starts, the backups' own rule, by
`backup_verify_every_days` (14). First due tonight at 01:00 Grande Prairie,
an hour behind the scheduled backup.

The run takes the newest complete backup folder and reads its
`files.json.gz`. For every entry, in name order from the cursor's offset: the
file is downloaded off the drive, hashed, and compared with its record.

## The repair

A file that is missing from the folder, cannot be read, or does not hash to
its record is read again from the bucket it came from and re-stored under
the same name, and its row in `backup_run_files` is updated with the new
hash, size and drive id.

- Reports and chat pictures never change at the source, so the repair puts
  back the identical bytes.
- Assessments, timesheets and shared files may have been re-rendered since
  the backup. The repair then stores today's copy in that folder and the
  record carries the new hash; the note says so. A good copy beats a
  damaged snapshot.
- A file whose source has gone cannot be repaired; it is counted
  `unrepairable` and named.

The folder's `files.json.gz` is rewritten from the rows at the end of any
slice in which a record changed — not only once the walk is done — so the
next carry-over and a restore read what is there now. A run that failed
halfway would otherwise leave the index naming the old hash for a file it
had already replaced, and a restore in between would refuse that good file
as `damaged`.

## What the panel shows

The run lists among the earlier runs as "File check" with one sentence:
"N of M files matched their record, R repaired from the app, U could not be
repaired" — or "nothing to repair". The last-run line shows the same
sentence with the notes beneath it. Beside "Next due" the panel says how
often every file is checked and when the next check is.

## Cost

Every file is downloaded once from the drive per pass, which is the drive's
egress. A year in at twenty reports a day that is about 1.6 GB every
fourteen days. Supabase egress only for repairs. The nightly spot check is
unchanged.
