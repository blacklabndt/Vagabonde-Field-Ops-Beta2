import { test } from "node:test";
import assert from "node:assert/strict";
import { savingLabel, deviceOffline, readFailure, SLOW_SAVE_MS, SLOW_SAVE_WORDS } from "./savingWords.js";

test("a save that lands quickly keeps the screen's own word", () => {
  assert.equal(savingLabel(0, "Saving…"), "Saving…");
  assert.equal(savingLabel(1, "Filing…"), "Filing…");
  assert.equal(savingLabel(SLOW_SAVE_MS - 1, "Sending…"), "Sending…");
});

test("a wait past the threshold says what is happening and where the work goes", () => {
  assert.equal(savingLabel(SLOW_SAVE_MS, "Saving…"), SLOW_SAVE_WORDS);
  assert.equal(savingLabel(8000, "Filing…"), SLOW_SAVE_WORDS);
  // The eight seconds this exists for: the wording must not have gone back.
  assert.match(SLOW_SAVE_WORDS, /kept on this device/);
});

test("a time that is not a number is the start of the wait, not the worry", () => {
  assert.equal(savingLabel(NaN, "Saving…"), "Saving…");
  assert.equal(savingLabel(undefined, "Saving…"), "Saving…");
  assert.equal(savingLabel(-100, "Saving…"), "Saving…");
});

test("only a flat false means the device knows it is offline", () => {
  assert.equal(deviceOffline({ onLine: false }), true);
  assert.equal(deviceOffline({ onLine: true }), false);
  // No navigator at all (a test runner, a worker) is not an offline device:
  // guessing offline here would send every save straight to the outbox.
  assert.equal(deviceOffline(null), false);
  assert.equal(deviceOffline({}), false);
});

test("readFailure names a missing grant as the office's problem", () => {
  const out = readFailure({ code: "42501", message: "permission denied for table tickets" });
  assert.match(out, /permission denied for table tickets/);
  assert.match(out, /42501/);
  assert.match(out, /office/);
});

test("readFailure recognises a permission refusal with no code", () => {
  assert.match(readFailure(new Error("permission denied for table tickets")), /42501/);
});

test("readFailure passes every other failure through in the server's words", () => {
  assert.equal(readFailure(new Error("Failed to fetch")), "Failed to fetch");
  assert.equal(readFailure({ code: "PGRST103", message: "Requested range not satisfiable" }),
    "Requested range not satisfiable");
});

test("readFailure never returns nothing", () => {
  assert.equal(readFailure(null), "the read failed");
  assert.equal(readFailure({}), "the read failed");
});
