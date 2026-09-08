// What a backup is made of: which tables, in what order, and which columns
// never leave the building.
//
// Erasable TypeScript only, and no imports: vite-app/src/backupShared.test.mjs
// imports this file straight out of supabase/functions/ and node strips the
// types. An enum or a parameter property here breaks the test suite.
//
// Two orders, and they are not each other's reverse. LOAD_ORDER is
// parents-first, so an insert never names a row that is not there yet.
// WIPE_ORDER is the delete order supabase/handover/wipe-seed-data.sql
// worked out the hard way — children first, profiles last because every
// other table names it, and audit_log and function_errors in there too
// because their foreign keys to profiles would otherwise abort the whole
// transaction. The test reads the handover script back and compares.

export const LOAD_ORDER: string[] = [
  // profiles first of all: every other table's created_by, technician_id
  // and profile_id points at it. Its own id is a foreign key to
  // auth.users, which is why a restore creates the missing Auth accounts
  // BEFORE it loads this table, not after.
  "profiles",
  "clients",
  "contractors",
  // No foreign key of its own — org_id is a discriminated reference — but
  // jobs.client_contact_id and jobs.contractor_contact_id both name it, so
  // it loads before jobs.
  "contacts",
  "rate_schedules",
  "rate_lines",
  "rate_line_history",
  "jobs",
  "rate_overrides",
  "tickets",
  "ticket_lines",
  "ticket_crew",
  "jhas",
  "reports",
  "equipment",
  "timesheet_approvals",
  // chat_messages.reply_to points at chat_messages, so its rows are loaded
  // oldest first — a reply is always newer than the message it quotes.
  "chat_messages",
  "chat_reactions",
  "chat_reads",
  "push_subscriptions",
  "arcade_scores",
  "burned_ticket_numbers",
  // Last, and restored by a narrow UPDATE rather than an insert: this row
  // holds the drive connection the restore is running through.
  "app_settings"
];

export const BACKUP_TABLES: string[] = LOAD_ORDER;

export const WIPE_ORDER: string[] = [
  "ticket_crew",
  "ticket_lines",
  // tickets before burned_ticket_numbers, not after: tickets_burn_issued_number
  // is BEFORE DELETE on tickets (baseline line 1184) and inserts a row into
  // burned_ticket_numbers for every ticket carrying approval_sent_at, so
  // clearing the burn list first leaves exactly as many rows behind as there
  // were sent tickets deleted after it — and the restore would then load the
  // backup's list on top of a table that is not empty.
  "tickets",
  "burned_ticket_numbers",
  "timesheet_approvals",
  "jhas",
  "reports",
  "rate_overrides",
  "jobs",
  // rate_lines before its history, not after: rate_lines_history_trigger is
  // AFTER INSERT OR DELETE OR UPDATE on rate_lines (baseline line 1182) and
  // writes a history row for every one of those, so clearing the history
  // first leaves exactly as many phantom rows behind as there were lines
  // deleted after it. The ruling for the restore follows from the same
  // trigger's INSERT arm: it loads rate_lines — whose inserts each write a
  // fresh history row of their own — then deletes every rate_line_history
  // row, and only then loads the backup's history file, so neither the
  // delete's phantoms nor the insert's survive into the restored database.
  "rate_lines",
  "rate_line_history",
  "rate_schedules",
  "contacts",
  "clients",
  "contractors",
  "chat_reactions",
  "chat_reads",
  "chat_messages",
  "push_subscriptions",
  "arcade_scores",
  // Not backed up — operational noise — but they carry foreign keys to
  // profiles, so they have to go before profiles can. A restored database
  // therefore starts with an empty error log and an empty audit trail, and
  // the panel says so.
  "function_errors",
  "audit_log",
  "equipment",
  "profiles"
];

export const NEVER_WIPED: string[] = ["app_settings"];

export const BUCKETS: string[] = ["reports", "jhas", "shared", "timesheets", "chat-media"];

// Stripped from the app_settings row on its way into a backup. A backup
// lives in somebody's consumer drive; a Resend key in it is a key posted to
// a consumer drive. The list is checked against the migrations by the test:
// a later app_settings column whose name says key, secret or token must be
// added here.
//
// The rule the restore follows, recorded here because this is where the
// nulls come from: an app_settings column that is in this list AND null in
// the backup is SKIPPED on restore, never written. Every backup carries a
// null where the key was, so writing those nulls back would disconnect
// Resend and GIF search on a database whose own keys were perfectly good —
// the restore would silently take the mail out of the building. A non-null
// value in one of these columns is a backup taken before this list existed
// and is restored like any other column.
export const APP_SETTINGS_SECRETS: string[] = [
  "resend_api_key",
  "klipy_api_key",
  "backup_refresh_token",
  "backup_oauth_state",
  "backup_client_secret_google",
  "backup_client_secret_microsoft",
  "backup_client_secret_dropbox"
];

// Never written back by a restore. Restoring the drive connection out of a
// backup would point the running restore at whatever drive was connected
// when that backup was taken — possibly none at all, mid-restore.
export const APP_SETTINGS_NEVER_RESTORED: string[] = [
  "id",
  "backup_provider",
  "backup_refresh_token",
  "backup_account",
  "backup_root_folder_id",
  "backup_connection_error",
  "backup_oauth_state",
  "backup_oauth_state_at",
  "backup_client_id_google",
  "backup_client_secret_google",
  "backup_client_id_microsoft",
  "backup_client_secret_microsoft",
  "backup_client_id_dropbox",
  "backup_client_secret_dropbox",
  "backup_frequency",
  "backup_weekday",
  "backup_hour",
  "backup_keep",
  "backup_next_run_at",
  // The fortnightly file check's clock and interval: the engine's, like the
  // schedule above.
  "backup_verify_every_days",
  "backup_verify_next_at"
];

export const TABLE_KEYS: Record<string, string[]> = {
  profiles: ["id"],
  clients: ["id"],
  contractors: ["id"],
  contacts: ["id"],
  rate_schedules: ["id"],
  rate_lines: ["id"],
  rate_line_history: ["id"],
  jobs: ["id"],
  rate_overrides: ["id"],
  tickets: ["id"],
  ticket_lines: ["id"],
  ticket_crew: ["id"],
  jhas: ["id"],
  reports: ["id"],
  equipment: ["id"],
  timesheet_approvals: ["id"],
  chat_messages: ["id"],
  chat_reactions: ["message_id", "profile_id", "emoji"],
  chat_reads: ["profile_id"],
  push_subscriptions: ["id"],
  arcade_scores: ["game", "profile_id"],
  burned_ticket_numbers: ["id"],
  app_settings: ["id"]
};

// How a table is walked past PostgREST's silent 1,000-row cap. A single
// unique column means keyset — "the next thousand after this id" — which
// cannot skip a row when one is inserted mid-walk, and every table holding
// money, hours or dose has one. The two with a composite primary key are
// walked by OFFSET instead: chat_reactions is thumbs-ups and arcade_scores
// is a high-score table, and a reappearing or missing row in either is not
// something anybody is paid from.
export const CURSOR_COLUMN: Record<string, string | null> = {
  profiles: "id",
  clients: "id",
  contractors: "id",
  contacts: "id",
  rate_schedules: "id",
  rate_lines: "id",
  rate_line_history: "id",
  jobs: "id",
  rate_overrides: "id",
  tickets: "id",
  ticket_lines: "id",
  ticket_crew: "id",
  jhas: "id",
  reports: "id",
  equipment: "id",
  timesheet_approvals: "id",
  chat_messages: "id",
  chat_reactions: null,
  chat_reads: "profile_id",
  push_subscriptions: "id",
  arcade_scores: null,
  burned_ticket_numbers: "id",
  app_settings: "id"
};

// Every foreign key to public.profiles, table by table, split by whether
// the column may be null. It is here because a restore can find itself with
// a person it cannot put back: profiles.id is a foreign key to auth.users,
// and an Auth account that refuses to be re-created (an address already
// taken by somebody else, a backup with no address in it at all) leaves a
// profile row that cannot be inserted either. Every row that names that
// person then has to be dealt with, or the whole table's load fails on a
// foreign key nobody will ever satisfy.
//
// `required` is a column the row cannot exist without: those rows are left
// out and counted as skipped. `optional` is a column the row can stand
// without: the name is blanked and the row goes in, because a job whose
// creator could not be re-created is still the job. Read off the live
// catalogs (pg_constraint, contype 'f', confrelid public.profiles); the
// tables that are never loaded — audit_log, function_errors, backup_runs —
// are deliberately not in it.
export const PROFILE_REFS: Record<string, { required: string[]; optional: string[] }> = {
  // Its own id: an account that could not be created is a profile row that
  // cannot be inserted at all.
  profiles: { required: ["id"], optional: [] },
  jobs: { required: [], optional: ["created_by"] },
  rate_line_history: { required: [], optional: ["changed_by"] },
  tickets: { required: [], optional: ["technician_id"] },
  ticket_crew: { required: ["profile_id"], optional: [] },
  jhas: { required: [], optional: ["signed_by"] },
  equipment: { required: [], optional: ["assigned_to"] },
  timesheet_approvals: { required: ["profile_id"], optional: ["approved_by"] },
  chat_messages: { required: ["profile_id"], optional: ["pinned_by"] },
  chat_reactions: { required: ["profile_id"], optional: [] },
  chat_reads: { required: ["profile_id"], optional: [] },
  push_subscriptions: { required: ["profile_id"], optional: [] },
  arcade_scores: { required: ["profile_id"], optional: [] }
};

// The second order of orphan, and it follows from the first. A restore that
// leaves an account out leaves that person's chat messages out with them —
// chat_messages.profile_id is NOT NULL — and a row whose own NOT NULL
// foreign key names one of those messages then has nowhere to go either.
// One batch of them is one refused write, after the wipe, with the database
// empty.
//
// Read off pg_constraint (contype 'f') against the live project, asking for
// every NOT NULL foreign key whose parent is a table the restore can thin —
// that is, a table PROFILE_REFS gives a `required` column. There is exactly
// one: chat_reactions.message_id. chat_reads names profiles and never a
// message, and nothing at all names ticket_crew, timesheet_approvals,
// push_subscriptions or arcade_scores. chat_messages.reply_to is a nullable
// self-reference and is dealt with by the second chat pass instead.
export const LIVE_PARENT_REFS: Record<string, { column: string; parent: string }> = {
  chat_reactions: { column: "message_id", parent: "chat_messages" }
};

// What "restore these jobs" reaches for, in the order it inserts them.
export const JOB_CHILD_TABLES: string[] = [
  "tickets", "ticket_lines", "ticket_crew", "jhas", "reports", "rate_overrides"
];

// PostgREST answers at most 1,000 rows per request, silently.
export const PAGE_ROWS = 1000;

// A part is uploaded and forgotten, so this is the ceiling on how much of
// one table is held in a function's memory at once. Twenty-five pages of
// ticket_lines is a few megabytes of JSON before gzip.
export const MAX_PART_ROWS = 25000;

// A copy of the rows with the credential columns emptied. The caller's rows
// are never touched: they are also what gets counted and what the manifest
// records.
export function stripSecrets(table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (table !== "app_settings") return rows;
  return rows.map(row => {
    const out: Record<string, unknown> = { ...row };
    for (const column of APP_SETTINGS_SECRETS) {
      if (column in out) out[column] = null;
    }
    return out;
  });
}

// One flat path segment — every provider reads a "/" in a name as a folder
// boundary — numbered from 01 so the parts sort into their own order.
export function partFileName(table: string, index: number): string {
  return `${table}.${String(index + 1).padStart(2, "0")}.json.gz`;
}

export function chunkRows<T>(rows: T[], max: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += max) out.push(rows.slice(i, i + max));
  return out;
}
