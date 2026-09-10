// What the office needs to be told, worked out from what the database
// already records.
//
// A failed backup, a drive whose consent lapsed, a schedule nothing is
// picking up and a run of background errors are all written down the
// moment they happen — in backup_runs, in app_settings and in
// function_errors — and all four are then only visible to somebody who
// opens the Admin screen and looks. For a one-person office that can be
// weeks. This is the reading of those records, kept pure so both the
// people who need it can share the wording: Home's attention strip calls
// it in the browser, and the admin-digest function repeats it in
// TypeScript to decide whether there is an email to send.
//
// Every item is a fact and a next step, deliberately in two halves: the
// fact belongs on the strip whatever screen you are on, and the step has
// to name where to look, because Home has no way to switch tabs for you.

// The error log's window. A day, so "since yesterday" means the same
// thing at 06:00 and at 23:00 — a window pinned to midnight would go
// quiet every morning with the night's failures still unread.
export const ERRORS_WINDOW_MS = 24 * 60 * 60 * 1000;

// How late a backup has to be before lateness is news. The tick runs every
// five minutes and moves next_run_at the moment a run STARTS, so a due
// date still in the past hours later means nothing is picking it up at
// all — a slow run has already moved the date. Six hours is short enough
// to catch a night that never happened and long enough that a paused
// project or a clock a little out does not cry wolf.
export const OVERDUE_GRACE_MS = 6 * 60 * 60 * 1000;

// backup_runs holds restores as well as backups, and "Last backup failed"
// is the wrong sentence for a restore that died. Same kinds the panel
// names, same words.
export const KIND_WORDS = {
  backup: "backup",
  before_restore: "safety backup",
  restore_all: "restore",
  restore_jobs: "job restore",
  verify: "file check"
};

// Plain distance in the past. Hours below a day because "0 days ago" is
// not English, and a failure an hour old reads very differently from one
// three days old — which is the whole point of putting it on the strip.
export function agoPhrase(ms) {
  const d = Math.max(0, Number(ms) || 0);
  if (d < 3600000) return "less than an hour ago";
  if (d < 86400000) {
    const hours = Math.floor(d / 3600000);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(d / 86400000);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// Which functions have been failing, busiest first, so the line names the
// one worth opening rather than listing the log alphabetically.
function byFunction(rows) {
  const counts = new Map();
  for (const r of rows) {
    const name = String((r && r.function_name) || "unknown");
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name} (${n})`);
}

// backupState is backup_state()'s answer (or nothing, if the read was
// refused or never made); errors is the most recent function_errors rows;
// now is a millisecond clock. Returns [] when there is nothing to say,
// which is what keeps the strip off the board on an ordinary morning.
export function attentionItems(backupState, errors, now) {
  const at = Number(now) || Date.now();
  const s = backupState || {};
  const items = [];

  // First, because it is the one that stops everything else: an expired
  // consent means no backup will run at all until somebody reconnects.
  const connectionError = String(s.connection_error || "").trim();
  if (connectionError) {
    items.push({
      key: "connection",
      // The signature is the error's own words: a different refusal (or the
      // same one clearing) is different news and the strip should return.
      sig: connectionError,
      text: `The backup drive needs reconnecting — ${connectionError}`,
      where: "Open the Admin screen, Automatic backup, and connect the drive again. Backups are not running until you do."
    });
  }

  const last = s.last_run || null;
  if (last && last.status === "failed") {
    const word = KIND_WORDS[last.kind] || "backup";
    const stamp = last.finished_at || last.started_at || "";
    const finished = Date.parse(stamp);
    const ago = Number.isFinite(finished) ? ` ${agoPhrase(at - finished)}` : "";
    items.push({
      key: "failed-run",
      // One run, one signature — a later failure is a later stamp, so a fresh
      // bad night lifts a dismissal even when yesterday's is still on record.
      sig: String(stamp),
      // The fact belongs on the board; the reason does not. Every failed run
      // writes its error to function_errors as well, so the Recent background
      // errors card is where the stack lives — a raw "TypeError: error
      // sending request … connection reset" across the top of Home reads as
      // the app itself breaking, and it cannot be dismissed or acted on there.
      text: `Last ${word} failed${ago}`,
      // A file check has no button of its own — the tick is the only door,
      // and nextVerifyAt moved the clock a fortnight on the moment this run
      // started. "Start another" would send Kyle to something that is not
      // there, and Back up now queues a backup, not a check.
      where: last.kind === "verify"
        ? "Open the Admin screen, Recent background errors, to see what went wrong. The next file check is a fortnight off; tonight's backup does not repeat it."
        : "Open the Admin screen, Recent background errors, to see what went wrong. Automatic backup can start another."
    });
  }

  // Nothing has picked the schedule up. Only worth saying when a drive is
  // connected and answering: with no connection there is no schedule to be
  // late for, and with a lapsed one the line above already names the cause
  // and the fix — two lines about one broken drive is noise, and the
  // second of them would send Kyle to a button that cannot work yet.
  const due = Date.parse(s.next_run_at || "");
  if (s.connected && !connectionError && Number.isFinite(due) && at - due > OVERDUE_GRACE_MS) {
    items.push({
      key: "overdue",
      // The due date itself: once the tick finally picks it up the date moves
      // and this clears; a fresh missed date is a fresh signature.
      sig: String(s.next_run_at || ""),
      text: `A backup was due ${agoPhrase(at - due)} and has not started`,
      where: "Open the Admin screen, Automatic backup, and press Back up now."
    });
  }

  // A row stamped a moment ahead of this device's clock is still one of
  // today's — a tablet a minute fast must not hide the error it just
  // caused — so only the far side of the window is tested.
  const recent = (errors || []).filter(e => {
    const t = Date.parse((e && e.created_at) || "");
    return Number.isFinite(t) && at - t <= ERRORS_WINDOW_MS;
  });
  if (recent.length) {
    // The count and the newest stamp: one more error, or a later one, is a
    // new signature and lifts a dismissal — the whole point of "until a new
    // one arrives". Grouping the same functions again is not.
    const newest = recent.reduce((m, e) => {
      const t = Date.parse((e && e.created_at) || "");
      return Number.isFinite(t) && t > m ? t : m;
    }, 0);
    items.push({
      key: "errors",
      sig: `${recent.length}@${newest}`,
      text: `${recent.length} background error${recent.length === 1 ? "" : "s"} since yesterday — ${byFunction(recent).join(", ")}`,
      where: "Open the Admin screen, Recent background errors."
    });
  }

  return items;
}

// The strip can be waved away, and stays down until the trouble itself
// changes. "The same trouble" is this signature: the ordered keys of what is
// showing, each with a small mark of its own identity (sig above) — a
// different refusal, a later failure, one more error each read as different.
// An empty string is "nothing to say", which must never match a stored
// dismissal, or a calm morning after a dismissed night would stay hidden.
export function attentionSignature(items) {
  return (items || []).map(i => `${i.key}:${i.sig || ""}`).join("|");
}

// Kept in Store (localStorage), per account on this device — the same shape
// as help.tipsOff.<id>, and for the same reason: a shared tablet must not let
// one Admin's dismissal silence the next. Store outlives the device cache, so
// signing out and back in keeps a dismissal; a genuinely new problem carries
// a new signature and returns regardless.
export function attentionDismissedKey(userId) {
  return "attention.dismissed." + userId;
}

// Is this exact set of problems the one this account last waved away? Only a
// real signature can match — no account and no signature are never suppressed.
export function attentionSuppressed(store, userId, signature) {
  if (!userId || !signature) return false;
  return store.load(attentionDismissedKey(userId), "") === signature;
}

// Remember that this account has read this exact set of problems. A missing
// account or an empty signature writes nothing — there is nothing to dismiss.
export function dismissAttention(store, userId, signature) {
  if (!userId || !signature) return;
  store.save(attentionDismissedKey(userId), signature);
}

// Forget the dismissal: the trouble it was for has cleared, and the next
// trouble is news whatever it says. The one refusal whose words never change
// — the drive's "invalid_grant" — signs identically the day it comes back,
// and a dismissal that outlived the clearing kept it hidden for ever, with
// backups not running and Home silent. Home calls this only once its reads
// have answered: before then, and when a read failed, an empty signature
// means "nothing could be read", not "all clear".
export function clearDismissedAttention(store, userId) {
  if (!userId) return;
  store.save(attentionDismissedKey(userId), "");
}
