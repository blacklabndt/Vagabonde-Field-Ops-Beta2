import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('replay distinguishes conversion loss from text-input arithmetic mismatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decimal-replay-'));
  try {
    const input = join(dir, 'rows.json');
    writeFileSync(input, JSON.stringify([
      { quantity: '1', unit_rate: '1.0049999999999999999', stored: '1.00' },
      { quantity: '1', unit_rate: '1.001', stored: '1.00' }
    ]));
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./round3-decimal-parity.mjs', import.meta.url)), input], { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stderr);
    const [sensitive, ordinary, summary] = run.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(sensitive.fromText, 1);
    assert.equal(sensitive.fromNumber, 1.01);
    assert.equal(sensitive.textMatches, true);
    assert.equal(sensitive.numberMatches, false);
    assert.equal(sensitive.conversionSensitive, true);
    assert.equal(ordinary.conversionSensitive, false);
    assert.equal(summary.textMismatches, 0);
    assert.equal(summary.numberMismatches, 1);
    assert.equal(summary.conversionSensitiveRows, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
