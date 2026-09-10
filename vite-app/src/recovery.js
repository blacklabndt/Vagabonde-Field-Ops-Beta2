// Catching a password-reset landing before anyone else can eat the
// evidence.
//
// supabase-js starts consuming the recovery hash the moment the client is
// created — at module evaluation, before React mounts — and on a slow
// device its network continuation can clear the hash and fire the one-shot
// PASSWORD_RECOVERY event before any component subscribes (the event is
// never replayed to late subscribers). A hash check or an effect-time
// subscription inside App.jsx therefore both lose the race sometimes.
//
// This module runs at import, in the same synchronous evaluation as the
// client itself: the hash is still untouched when it looks, and the
// subscription exists before the event can possibly fire.
import { sbClient } from "./config.js";

// What a genuine reset landing looks like: Auth puts the whole recovery
// session in the hash — `#access_token=…&refresh_token=…&type=recovery` —
// and both halves are required here.
//
// `type=recovery` on its own is just a word anybody can put in a URL, and it
// used to be enough: loading `…/#type=recovery` while somebody was signed in
// opened the real "Set a new password" screen over their live session, with
// no token involved at any point. Save behind it would have changed that
// account's password. Team chat linkifies URLs, so a message carrying that
// address and a plausible sentence showed the app's own password screen —
// an induced password change made to look native. With no token there is no
// recovery session and nothing to set a password with, so it is not one.
function readRecoveryHash() {
  if (typeof window === "undefined") return false;
  const p = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
  return p.get("type") === "recovery" && !!p.get("access_token");
}
let pending = readRecoveryHash();
// A bare `type=recovery` is also taken out of the address bar. Nothing else
// reads it, and leaving it there means a bookmark or a forwarded link keeps
// asking the same question on every load.
if (typeof window !== "undefined" && !pending
    && new URLSearchParams((window.location.hash || "").replace(/^#/, "")).get("type") === "recovery"
    && window.history && window.history.replaceState) {
  window.history.replaceState(null, "", (window.location.pathname || "") + (window.location.search || ""));
}
const listeners = new Set();

// A link that has expired, or has already been used once, never becomes a
// recovery session at all: Auth bounces it back as
// #error=access_denied&error_code=otp_expired&error_description=… and
// supabase-js drops it. Read here, in the same evaluation as the hash above,
// so the sign-in screen can say why rather than sitting there mute while the
// person taps the dead link again.
function readLinkError() {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
  const code = p.get("error_code");
  if (!code && !p.get("error")) return null;
  if (code === "otp_expired" || /expired/i.test(p.get("error_description") || "")) {
    return "That password link has expired or has already been used. Sign in below, or tap Forgot password for a fresh one.";
  }
  // Anything else: Auth's own words, which are written for people, plus the
  // one thing they can do about it.
  const desc = (p.get("error_description") || "").trim();
  return (desc ? desc.replace(/\.$/, "") : "That password link didn't work") + ". Tap Forgot password for a fresh one.";
}
const linkError = readLinkError();

sbClient.auth.onAuthStateChange(event => {
  if (event === "PASSWORD_RECOVERY" && !pending) {
    pending = true;
    listeners.forEach(fn => { fn(true); });
  }
});

export const Recovery = {
  pending: () => pending,
  clear() { pending = false; },
  // A plain sentence when the link landed with a complaint instead of a
  // session; null on every ordinary start.
  error: () => linkError,
  // fn(true) whenever a recovery session is detected after subscription.
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
};
