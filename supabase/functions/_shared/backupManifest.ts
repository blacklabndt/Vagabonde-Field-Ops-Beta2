// The manifest, the folder names, and which old folders retention removes.
//
// Erasable TypeScript only; the one import is the shared schedule, for the
// Grande Prairie clock a folder is stamped on. The node suite imports this
// file directly.

import { zonedFields } from "./backupSchedule.ts";

export const BACKUP_ROOT_NAME = "VagaboNDE backups";
export const MANIFEST_NAME = "manifest.json";
export const TABLES_FOLDER = "tables";
export const FILES_FOLDER = "files";
export const BEFORE_RESTORE_PREFIX = "before-restore ";

export interface ManifestJob {
  id: string;
  job_number: string;
  client: string;
  project: string;
  created_at: string;
  status: string;
  tickets: number;
  jhas: number;
  reports: number;
}

export interface Manifest {
  app_version: string;
  schema_version: string | null;
  started_at: string;
  finished_at: string | null;
  tables: Record<string, { rows: number; parts: string[] }>;
  // `reused` is how many of `count` were copied over on the drive from
  // the night before rather than read out of Supabase (backupRun.ts).
  files: { count: number; bytes: number; reused?: number };
  jobs: ManifestJob[];
  note: string;
}

const NOTE =
  "A complete copy of VagaboNDE Field Ops. It contains the crew's private " +
  "hours and dose readings and every client's pricing, so it belongs only " +
  "in the account it was written to. Vendor keys and drive credentials are " +
  "not in it.";

export function newManifest(appVersion: string, schemaVersion: string | null, startedAt: string): Manifest {
  return {
    app_version: appVersion,
    schema_version: schemaVersion,
    started_at: startedAt,
    finished_at: null,
    tables: {},
    files: { count: 0, bytes: 0 },
    jobs: [],
    note: NOTE
  };
}

export function recordTable(m: Manifest, table: string, rows: number, parts: string[]): Manifest {
  m.tables[table] = { rows, parts };
  return m;
}

// Added to rather than set: a run is made of slices and the files phase
// crosses several of them.
export function recordFiles(m: Manifest, count: number, bytes: number, reused = 0): Manifest {
  m.files = { count: m.files.count + count, bytes: m.files.bytes + bytes, reused: (m.files.reused ?? 0) + reused };
  return m;
}

export function finishManifest(m: Manifest, finishedAt: string): Manifest {
  m.finished_at = finishedAt;
  return m;
}

// The index the per-job restore picks from: one line per job, with the
// counts that let an Admin recognise the job they meant.
export function jobsIndex(source: {
  jobs: Record<string, unknown>[];
  clients: Record<string, unknown>[];
  tickets: Record<string, unknown>[];
  jhas: Record<string, unknown>[];
  reports: Record<string, unknown>[];
}): ManifestJob[] {
  const clientName = new Map<string, string>();
  for (const c of source.clients || []) clientName.set(String(c.id), String(c.name ?? ""));

  const count = (rows: Record<string, unknown>[]) => {
    const n = new Map<string, number>();
    for (const r of rows || []) {
      const k = String(r.job_id ?? "");
      n.set(k, (n.get(k) || 0) + 1);
    }
    return n;
  };
  const tickets = count(source.tickets);
  const jhas = count(source.jhas);
  const reports = count(source.reports);

  return (source.jobs || []).map(j => {
    const id = String(j.id);
    return {
      id,
      job_number: String(j.job_number ?? ""),
      client: j.client_id ? (clientName.get(String(j.client_id)) ?? "") : "",
      project: String(j.project ?? ""),
      created_at: String(j.created_at ?? ""),
      status: String(j.status ?? ""),
      tickets: tickets.get(id) || 0,
      jhas: jhas.get(id) || 0,
      reports: reports.get(id) || 0
    };
  });
}

// "2026-09-04 02-05" — the crew's own clock, and no colon, because a colon
// is not a legal filename character on Windows and these folders get synced
// down to Windows machines.
export function folderStamp(ms: number): string {
  const f = zonedFields(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${f.year}-${p(f.month)}-${p(f.day)} ${p(f.hour)}-${p(f.minute)}`;
}

export function beforeRestoreName(stamp: string): string {
  return BEFORE_RESTORE_PREFIX + stamp;
}

export function isBeforeRestore(name: string): boolean {
  return String(name || "").startsWith(BEFORE_RESTORE_PREFIX);
}

// A backup folder and nothing else: the stamp shape exactly. A folder
// somebody put in the same drive themselves is not retention's business.
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}$/;

// The stamp sorts lexicographically into date order, so "the newest N" is
// the tail of a plain sort. A before-restore folder is never in the running:
// it is the copy taken immediately before somebody replaced the database,
// and it is the one folder nobody should lose to a retention count.
//
// `spare` is the folder a restore is reading from right now. Age is the
// wrong question to ask about it — a restore is usually FROM an older
// backup, which is exactly the folder a keep of 1 would delete — so it is
// named rather than counted, and taken out after the count.
export function foldersToDelete(names: string[], keep: number, spare: Iterable<string> = []): string[] {
  const n = Math.max(1, Math.trunc(Number(keep)) || 1);
  const spared = new Set<string>();
  for (const name of spare || []) if (name) spared.add(String(name));
  const backups = (names || []).filter(name => STAMP.test(String(name))).sort();
  return backups.slice(0, Math.max(0, backups.length - n)).filter(name => !spared.has(name));
}

// One flat, reversible path segment for a stored object: the bucket and the
// key together, percent-encoded, so a key with slashes in it does not turn
// into a tree of drive folders.
export function fileEntryName(bucket: string, key: string): string {
  return encodeURIComponent(`${bucket}/${key}`);
}

export function parseFileEntryName(name: string): { bucket: string; key: string } | null {
  let decoded: string;
  try { decoded = decodeURIComponent(String(name || "")); } catch { return null; }
  const cut = decoded.indexOf("/");
  if (cut <= 0 || cut === decoded.length - 1) return null;
  return { bucket: decoded.slice(0, cut), key: decoded.slice(cut + 1) };
}

// Schema versions are the migration stamps, which sort as strings. A backup
// from a newer schema holds columns this database has not got, so loading it
// would fail halfway; that one is refused. Not knowing either version is
// not evidence of anything, so it is not a refusal.
export function schemaTooNew(backupVersion: string | null, liveVersion: string | null): boolean {
  if (!backupVersion || !liveVersion) return false;
  return String(backupVersion) > String(liveVersion);
}
