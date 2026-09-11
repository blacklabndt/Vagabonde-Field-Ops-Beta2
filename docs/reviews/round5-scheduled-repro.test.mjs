import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { localToUtc, checkRunAt, STUCK_MS, STUCK_WORDS, fireGate, isKind, resultPushWords, NO_DEVICE_WORDS, NO_DEVICE_TOOK_IT } from '../../supabase/functions/_shared/scheduledSends.ts';

// These tests reproduce current defects; passing means the defect is present.
const source = readFileSync(new URL('../../supabase/functions/scheduled-sends/index.ts', import.meta.url), 'utf8');
const start = source.indexOf('Deno.serve(') + 'Deno.serve('.length;
const end = source.indexOf('\n});', start) + 2;
const makeHandler = new Function('createClient', 'Deno', 'secretsMatch', 'json', 'STUCK_MS', 'STUCK_WORDS', 'BATCH', 'appSettings', 'fire', 'tellScheduler', 'logError',
  `return (${stripTypeScriptTypes(source.slice(start, end))});`);

function fixture({ statusError = false, fireError = false, claimed = true, authorized = true } = {}) {
  const state = { status: 'queued', deliveries: 0, notices: [], logs: [] };
  const row = { id: 's1', kind: 'report', label: 'Report test.pdf', to_list: 'rep@example.com', run_at: '2026-09-11T12:00:00Z', set_by: 'u1', record_id: 'r1', job_id: 'j1', jobs: { job_number: 'J1' } };
  const admin = {
    rpc: async () => ({ data: 'secret', error: null }),
    from(table) {
      assert.equal(table, 'scheduled_sends');
      let patch, id = null;
      const filters = [];
      return {
        update(p) { patch = p; return this; },
        select() { return this; },
        eq(key, value) { if (key === 'id') id = value; filters.push([key, value]); return this; },
        lt() { return this; }, lte() { return this; }, order() { return this; }, limit() { return this; },
        then(resolve) {
          if (!patch) return resolve({ data: [row], error: null });
          if (!id) return resolve({ data: [], error: null }); // stuck cleanup
          if (patch.status === 'sending') {
            assert.ok(filters.some(([k, v]) => k === 'status' && v === 'queued'));
            if (!claimed) return resolve({ data: [], error: null });
            state.status = 'sending';
            return resolve({ data: [{ id }], error: null });
          }
          if (statusError) return resolve({ data: null, error: { message: 'status write refused' } });
          state.status = patch.status;
          resolve({ data: null, error: null });
        }
      };
    }
  };
  const handler = makeHandler(() => admin, { env: { get: () => 'test' } }, () => authorized,
    (body, status = 200) => ({ body, status }), STUCK_MS, STUCK_WORDS, 20, async () => ({}),
    async () => { if (fireError) throw new Error('delivery refused'); state.deliveries++; },
    async (_db, _row, error) => { state.notices.push(error); },
    async (...args) => { state.logs.push(args); });
  return { state, run: () => handler({ method: 'POST', headers: { get: () => 'secret' } }) };
}

test('control: unauthorized ticks cannot claim or deliver', async () => {
  const f = fixture({ authorized: false });
  assert.equal((await f.run()).status, 401);
  assert.equal(f.state.deliveries, 0);
});
test('control: losing the queued claim cannot deliver', async () => {
  const f = fixture({ claimed: false });
  assert.equal((await f.run()).body.fired, 0);
  assert.equal(f.state.deliveries, 0);
});
test('control: successful delivery records sent', async () => {
  const f = fixture();
  assert.equal((await f.run()).body.fired, 1);
  assert.equal(f.state.status, 'sent');
});
test('control: failed delivery records failed', async () => {
  const f = fixture({ fireError: true });
  assert.equal((await f.run()).body.failed, 1);
  assert.equal(f.state.status, 'failed');
});
test('defect: failed sent-status write still reports success and leaves sending', async () => {
  const f = fixture({ statusError: true });
  assert.deepEqual((await f.run()).body, { ok: true, fired: 1, failed: 0, stuck: 0 });
  assert.equal(f.state.status, 'sending');
  assert.equal(f.state.deliveries, 1);
  assert.deepEqual(f.state.notices, [null]);
  assert.equal(f.state.logs.length, 0);
});
test('defect: failed failure-status write also leaves sending with an ok response', async () => {
  const f = fixture({ statusError: true, fireError: true });
  assert.deepEqual((await f.run()).body, { ok: true, fired: 0, failed: 1, stuck: 0 });
  assert.equal(f.state.status, 'sending');
});
test('defect: nonexistent calendar date silently becomes December 1', () => {
  assert.equal(localToUtc('2026-11-31 07:00'), localToUtc('2026-12-01 07:00'));
  assert.doesNotThrow(() => checkRunAt(localToUtc('2026-11-31 07:00'), localToUtc('2026-09-11 07:00')));
});
test('defect: nonexistent spring-forward time silently becomes 01:30', () => {
  assert.equal(localToUtc('2026-03-08 02:30'), localToUtc('2026-03-08 01:30'));
});
test('defect: proposed time passes application guard but violates SQL insertion window', () => {
  const now = Date.UTC(2026, 8, 11, 15);
  const runAt = now - 2 * 60_000;
  assert.doesNotThrow(() => checkRunAt(runAt, now));
  const migration = readFileSync(new URL('../../supabase/migrations/20260911010317_a_reminder_is_a_timer_with_no_mail.sql', import.meta.url), 'utf8');
  assert.match(migration, /run_at > now\(\) - interval '1 minute'/);
  assert.equal(runAt > now - 60_000, false);
});

const fireStart = source.indexOf('async function fire(');
const fireEnd = source.indexOf('\n}', fireStart) + 2;
const makeFire = new Function('isKind', 'fireGate', 'devicesOf', 'sendPush', 'resultPushWords', 'NO_DEVICE_WORDS', 'NO_DEVICE_TOOK_IT', 'recipients', 'JHA_MAIL_SELECT', 'REPORT_MAIL_SELECT', 'mailJha', 'mailReport', 'mailApproval',
  `return (${stripTypeScriptTypes(source.slice(fireStart, fireEnd))});`);
function fireFixture(kind, { role = 'Technician', locked = false, missing = false, devices = 1, accepted = 1, ticketStatus = 'Draft' } = {}) {
  const calls = [];
  const person = { id: 'u1', role, tab_access: ['job', 'jha', 'upload', 'ticket'], deactivated_at: locked ? '2026-09-01' : null };
  const record = { id: 'r1', pdf_key: 'file.pdf', signed_by: 'u2', total: 100, technician_id: 'u1', status: ticketStatus };
  const admin = { from(table) {
    return {
      select() { return this; }, eq() { return this; },
      maybeSingle: async () => ({ data: table === 'profiles' ? person : missing ? null : record, error: null }),
      update(patch) { calls.push(['update', table, patch]); return this; },
      then(resolve) { resolve({ error: null }); }
    };
  } };
  const fire = makeFire(isKind, fireGate, async () => Array.from({ length: devices }, () => ({})),
    async () => { calls.push(['push']); return { sent: accepted }; }, resultPushWords, NO_DEVICE_WORDS, NO_DEVICE_TOOK_IT,
    value => value, 'jha columns', 'report columns',
    async () => { calls.push(['jha']); }, async () => { calls.push(['report']); },
    async (_db, id, to, cc, sentBy) => { calls.push(['approval', id, sentBy]); });
  return { calls, run: () => fire(admin, { id: 's1', kind, record_id: 'r1', set_by: 'u1', to_list: 'rep@example.com', label: 'Test', jobs: null }, async () => ({})) };
}
for (const kind of ['jha', 'report', 'ticket_approval', 'reminder']) {
  test(`control: real fire branch delivers ${kind} once`, async () => {
    const f = fireFixture(kind);
    await f.run();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][0], { jha: 'jha', report: 'report', ticket_approval: 'approval', reminder: 'push' }[kind]);
  });
  test(`control: real fire branch refuses locked scheduler for ${kind}`, async () => {
    const f = fireFixture(kind, { locked: true });
    await assert.rejects(f.run, /locked/);
    assert.equal(f.calls.length, 0);
  });
}
for (const kind of ['jha', 'report', 'ticket_approval']) {
  test(`control: deleted ${kind} is not delivered`, async () => {
    const f = fireFixture(kind, { missing: true });
    await assert.rejects(f.run, /deleted/);
    assert.equal(f.calls.length, 0);
  });
}
test('control: reminders fail explicitly without devices or accepted pushes', async () => {
  await assert.rejects(fireFixture('reminder', { devices: 0 }).run, /No device/);
  await assert.rejects(fireFixture('reminder', { accepted: 0 }).run, /No device/);
});
test('control: already approved tickets are refused and resends stamp the chase', async () => {
  await assert.rejects(fireFixture('ticket_approval', { ticketStatus: 'Approved' }).run, /already signed/);
  const f = fireFixture('ticket_approval', { ticketStatus: 'Awaiting approval' });
  await f.run();
  assert.deepEqual(f.calls[0], ['approval', 'r1', 'u1']);
  assert.equal(f.calls[1][1], 'tickets');
  assert.ok(f.calls[1][2].chased_at);
});
