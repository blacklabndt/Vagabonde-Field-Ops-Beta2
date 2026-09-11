// The address inside a contact label — vite-app/src/emailIn.js's twin, for
// Ask's chase (chasePlan.ts). Pure, no imports (backupShared.test.mjs guards
// that); askTwins.test.mjs holds the core to the panel's copy.

// ═══ shared core (twin: vite-app/src/emailIn.js) ═══
export const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
export const emailIn = (s: string | null | undefined): string => { const m = EMAIL_RE.exec(s || ""); return m ? m[0] : ""; };
// ═══ end shared core ═══
