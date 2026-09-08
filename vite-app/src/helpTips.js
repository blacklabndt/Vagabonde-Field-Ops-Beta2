// The screen tips. Each screen says what it is for — the words in help.js —
// in a popup, once per run of the app: "Ok" closes it and that screen stays
// quiet until the app is opened again, while the other screens still
// introduce themselves in the meantime. "No more tips" is the kill switch:
// no screen, ever again, for that account on this device.
//
// So there are two kinds of record, and only one of them is kept. Which
// screens have spoken during this run lives in memory alone (`tipRun()`
// below), which is what makes the tips come back on the next launch — a
// reload, a fresh tab, the icon on a tablet. The kill switch is a device
// preference in Store (localStorage), `help.tipsOff.<id>`, kept per
// account: Store is not the device cache — sign-out empties the cache and
// leaves this — so signing out and back in does not start the tips again
// for somebody who has turned them off, while another account on the same
// tablet is asked for itself.
//
// Pure on purpose: App.jsx hands in the Store and the run, and the test
// next door reaches everything.

export function tipsOffKey(userId) {
  return "help.tipsOff." + userId;
}

// The screens that have already spoken this run. A plain Set behind a
// factory so App.jsx does not have to know that, and so a new account
// signing in on the same device can simply be given a new one.
export function tipRun() {
  return new Set();
}

// Are tips switched off for this account on this device? Only a stored
// `true` turns them off: a record that is missing or nonsense leaves the
// help where a new hire can still meet it.
export function tipsAreOff(store, userId) {
  if (!userId) return false;
  return store.load(tipsOffKey(userId), false) === true;
}

// Should this screen introduce itself now? Whether it has anything to say
// is the caller's question — helpFor answers that — so this one is only
// about the switch and what has already been said this run.
export function tipDue(store, userId, screenKey, run) {
  if (!userId || !screenKey) return false;
  if (tipsAreOff(store, userId)) return false;
  return !(run && run.has(screenKey));
}

// This screen has spoken. App.jsx notes it as the popup goes up rather than
// when Ok is pressed, so a tip closed with Escape or the backdrop is not
// still owed — leaving and coming back to a screen in the same run should
// not raise it a second time.
export function noteTipSeen(run, screenKey) {
  if (!run || !screenKey) return;
  run.add(screenKey);
}

// "No more tips": one press, every screen, every run from here on, this
// account on this device. There is deliberately no way back — an account
// that has said it knows the app is not asked again, and a switch offering
// to start the tips over is one more control in the drawer for something
// nobody comes back to.
export function stopTips(store, userId) {
  if (!userId) return;
  store.save(tipsOffKey(userId), true);
}
