// Equality of two secrets that takes the same time whatever the answer.
//
// A `===` on two strings returns at the first character that differs, so
// the time it takes says how many leading characters the caller guessed
// right — and a secret presented over the network can then be recovered a
// character at a time, each one a few hundred tries instead of the whole
// thing at once. Every door the database signs its calls through
// (x-internal-secret: backupDoor, chat-push, chat-retention, admin-digest),
// the OAuth callback's nonce and the approval page's fingerprint compare
// through this instead of `===`.
//
// Every byte of what was presented is walked whatever matches, and the
// differences are folded into one accumulator with no branch on the way:
// the time depends on the length of the caller's own input and on nothing
// in the expected value — not where the two differ, and not its length
// either, because the walk is over the presented bytes and the expected
// ones are read modulo their count. An empty expected value matches
// nothing, so a door whose secret was never minted stays shut.
//
// Erasable TypeScript with no imports, like the other shared modules the
// node suite reads straight out of this folder.
export function secretsMatch(presented: string | null | undefined, expected: string | null | undefined): boolean {
  const a = new TextEncoder().encode(String(presented ?? ""));
  const b = new TextEncoder().encode(String(expected ?? ""));
  if (b.length === 0) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i % b.length];
  return diff === 0;
}
