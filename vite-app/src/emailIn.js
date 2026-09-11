// The one rule for pulling an address out of free text. The job record
// keeps a contact as one display string ("T. Beaudry · (780) 555-0142 ·
// t.beaudry@…"), so anything that needs to email them pulls the address
// back out rather than mailing the whole label.
//
// It lives twice: here for the screens (common.jsx re-exports it) and in
// supabase/functions/_shared/emailIn.ts for Ask's chase, which plans a chase
// the way the tracker does. The block between the markers is the same code
// in both, the function's copy annotated, and askTwins.test.mjs reads both
// files off disk and compares them the way backupSchedule's twin is held.

// ═══ shared core (twin: supabase/functions/_shared/emailIn.ts) ═══
export const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
export const emailIn = (s) => { const m = EMAIL_RE.exec(s || ""); return m ? m[0] : ""; };
// ═══ end shared core ═══
