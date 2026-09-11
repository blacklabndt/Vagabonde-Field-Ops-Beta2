// Whether the account asking is still an Admin — the whole question, in one
// pure answer the node suite can read.
//
// Every privileged function used to ask `profile.role !== "Admin"` and
// nothing else, against a profile row read through RLS. That is three
// questions short:
//
//  1. `deactivated_at` — delete-user locks a profile FIRST and then bans the
//     Auth user, and when the ban fails it says so and returns ok
//     (`banFailed: true`). In that state Auth still accepts the session and
//     a role-only check still reads "Admin", so the account keeps every
//     privileged route — including unlock-user, which would clear its own
//     lock and make the revocation undone for good.
//  2. `tab_access` — stripping every tab is a revocation in its own right:
//     `is_staff()` means at least one tab, so a zero-tab account is already
//     locked out of the API. The Edge doors were the one place that did not
//     know it. This needs no failure anywhere to be reached.
//  3. The read's own error — `const { data: profile }` discarded it, so a
//     database blink answered "no profile" and every door read that as an
//     ordinary refusal. It is not: nothing was learned, and a door that
//     cannot check must not open. Fail closed, and say it is worth retrying.
//
// The rank is asked LAST on purpose: a locked Admin and a locked Helper get
// the same words, so a refusal never tells a stranger which one they hold.
//
// Erasable TypeScript, no imports, no environment: the node suite imports
// this file directly, and `adminGate.ts` beside it is the Deno half that
// does the reading.

export interface AdminProfile {
  role?: string | null;
  tab_access?: string[] | null;
  deactivated_at?: string | null;
}

export interface AdminRefusal {
  error: string;
  status: number;
}

// A locked account and one with no sections left get the same sentence,
// because to the person holding it they are the same thing: somebody took
// this away, and another Admin is who puts it back.
export const LOCKED_WORDS =
  "This account is locked. Ask another Admin to unlock it.";

// Not a refusal of the person — a refusal to guess. 503, because the same
// press a moment later may well work.
export const UNCHECKED_WORDS =
  "Your account could not be checked just now, so nothing was done. Try again in a moment.";

// Answers null when the caller may go on, and the refusal otherwise.
//
// `readFailed` is the error supabase-js reports beside the data — pass it as
// a boolean so this stays free of the client's types. A caller that throws
// its read must pass true, not null.
export function adminRefusal(
  profile: AdminProfile | null | undefined,
  readFailed: boolean,
  refusal: string
): AdminRefusal | null {
  // Fail closed. Nothing below this line has anything to judge.
  if (readFailed) return { error: UNCHECKED_WORDS, status: 503 };
  // No row where there must be one is not "not an Admin": the profile is
  // created with the account, so its absence is the database disagreeing
  // with Auth. Refuse, and do not pretend to know which way.
  if (!profile) return { error: UNCHECKED_WORDS, status: 503 };
  if (profile.deactivated_at) return { error: LOCKED_WORDS, status: 403 };
  // Not an array, or an empty one: `is_staff()` would answer false, and the
  // API is already shut to them.
  const tabs = profile.tab_access;
  if (!Array.isArray(tabs) || !tabs.length) return { error: LOCKED_WORDS, status: 403 };
  if (profile.role !== "Admin") return { error: refusal, status: 403 };
  return null;
}

// What every door selects, spelled once so a door cannot ask for less than
// it is judged on. A `select("role")` that forgot the other two columns is
// exactly how this defect was written the first time.
export const ADMIN_SELECT = "role, tab_access, deactivated_at";
