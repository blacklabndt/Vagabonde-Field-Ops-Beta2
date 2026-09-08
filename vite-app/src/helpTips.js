// The screen tips. The first time an account opens a screen on this device
// it gets one popup saying what that screen is for — the words in help.js —
// with "Ok" to close it and "No more tips" to stop them on every screen at
// once. There is no clock: a screen already introduced stays quiet, and a
// screen nobody has opened yet still has its introduction waiting.
//
// Two kinds of record, both device preferences in Store (localStorage) and
// both kept per account: `help.seen.<id>.<screen>` for a screen that has
// been introduced, `help.tipsOff.<id>` for an account that has heard
// enough. Store is not the device cache — sign-out empties the cache and
// leaves these — so signing out and back in does not start the tour again,
// while another account on the same tablet gets its own.
//
// Pure on purpose: App.jsx hands in the Store, and the test next door
// reaches everything.

export function tipSeenKey(userId, screenKey) {
  return "help.seen." + userId + "." + screenKey;
}

export function tipsOffKey(userId) {
  return "help.tipsOff." + userId;
}

// Are tips switched off for this account on this device? Only a stored
// `true` turns them off: a record that is missing or nonsense leaves the
// help where a new hire can still meet it.
export function tipsAreOff(store, userId) {
  if (!userId) return false;
  return store.load(tipsOffKey(userId), false) === true;
}

// Does this screen still owe this account its introduction? Whether the
// screen has anything to say is the caller's question — helpFor answers
// that — so this one is only about the records.
export function tipDue(store, userId, screenKey) {
  if (!userId || !screenKey) return false;
  if (tipsAreOff(store, userId)) return false;
  return store.load(tipSeenKey(userId, screenKey), false) !== true;
}

// This screen has now been introduced. App.jsx writes it as the popup goes
// up rather than when Ok is pressed, so a tip closed with Escape or the
// backdrop does not come back the next time the screen is opened.
export function noteTipSeen(store, userId, screenKey) {
  if (!userId || !screenKey) return;
  store.save(tipSeenKey(userId, screenKey), true);
}

// "No more tips": one press, every screen, this account on this device.
export function stopTips(store, userId) {
  if (!userId) return;
  store.save(tipsOffKey(userId), true);
}

// The drawer's way back. Turning tips on again forgets which screens have
// been introduced, because by the time anybody reaches for that switch they
// have opened most of the screens once and the switch would otherwise do
// nothing they can see. `screenKeys` is the list to forget — TABS' keys.
export function startTips(store, userId, screenKeys) {
  if (!userId) return;
  store.save(tipsOffKey(userId), false);
  for (const key of screenKeys || []) store.save(tipSeenKey(userId, key), false);
}
