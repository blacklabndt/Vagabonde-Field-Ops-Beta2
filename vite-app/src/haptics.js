// A short vibration for confirmations a gloved technician may not be able to
// read on a screen washed out by daylight: a save landed, or something needs a
// look. Deliberately tiny — a tick, not a rumble.
//
// Off when the Animations switch is off (the app writes data-motion="off" on
// the root for exactly this kind of ambient feedback), and a no-op wherever the
// device has no vibration motor at all — every desktop, and iOS Safari, which
// does not implement the Vibration API. Never let it throw into a save path.
export function buzz(pattern = 10) {
  try {
    if (typeof document !== "undefined" &&
        document.documentElement.getAttribute("data-motion") === "off") return;
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(pattern);
  } catch (_) { /* vibration is a nicety, never a failure */ }
}
