import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixture.js';
import { runWorkflow, operationDir, readJournal } from '../src/workflow.js';
import { atomicWrite, secureDir, readRegular } from '../src/files.js';
import { HelperError } from '../src/errors.js';
import type { Pair } from '../src/types.js';

const opts = () => ({ relink: false, recover: false, phone: '60123456789', signal: new AbortController().signal, showCode() {}, log() {}, connectTimeoutMs: 0 });
const success: Pair = async ({ authDir, assertOwned }) => { await assertOwned(); await atomicWrite(path.join(authDir, 'creds.json'), '{"registered":true}', assertOwned); };
test('fresh pairing hands off after releasing auth lock and preserves config', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await runWorkflow(f.gateway, async args => { assert.equal((await f.gateway.status()).running, false); assert.ok(f.locks.has(f.target.authDir)); await success(args); f.calls.push('pair-closed'); }, opts());
  assert.ok(f.calls.indexOf('pair-closed') < f.calls.indexOf(`unlock:${f.target.authDir}`));
  assert.ok(f.calls.indexOf(`unlock:${f.target.authDir}`) < f.calls.indexOf('start:sales'));
  assert.equal((await f.gateway.status()).connected, true);
  assert.equal(await fs.readFile(f.target.configPath, 'utf8'), '{}');
  assert.equal(await readJournal(operationDir(f.target), f.target), undefined);
});
test('existing credentials require relink and are not touched', async t => {
  const f = await fixture(); t.after(f.cleanup); await secureDir(f.target.authDir);
  await atomicWrite(path.join(f.target.authDir, 'creds.json'), 'old');
  await assert.rejects(runWorkflow(f.gateway, success, opts()), { code: 'EXISTING_AUTH' });
  assert.equal(await fs.readFile(path.join(f.target.authDir, 'creds.json'), 'utf8'), 'old');
  assert.ok(!f.calls.includes('stop:sales'));
});
test('relink failure restores complete backup and original running state', async t => {
  const f = await fixture(); t.after(f.cleanup); await secureDir(f.target.authDir);
  for (const name of ['creds.json', 'session-example.json']) await atomicWrite(path.join(f.target.authDir, name), `old:${name}`);
  await assert.rejects(runWorkflow(f.gateway, async args => { await success(args); throw new HelperError('PAIR_TIMEOUT', 'timeout'); }, { ...opts(), relink: true }), { code: 'PAIR_TIMEOUT' });
  assert.equal(await fs.readFile(path.join(f.target.authDir, 'creds.json'), 'utf8'), 'old:creds.json');
  assert.equal(await fs.readFile(path.join(f.target.authDir, 'session-example.json'), 'utf8'), 'old:session-example.json');
  assert.ok((await f.gateway.status()).running);
});
test('previously stopped account stays stopped on failed pairing', async t => {
  const f = await fixture(); t.after(f.cleanup); f.setRunning(false);
  await assert.rejects(runWorkflow(f.gateway, async () => { throw new Error('failed'); }, opts()));
  assert.ok(!f.calls.includes('start:sales'));
});
test('successful pairing plus disconnected runtime retains new auth and recovers handoff', async t => {
  const f = await fixture(); t.after(f.cleanup); f.setConnect(false);
  await assert.rejects(runWorkflow(f.gateway, success, opts()), { code: 'HANDOFF_TIMEOUT' });
  assert.equal((await readJournal(operationDir(f.target), f.target))?.phase, 'handoff');
  assert.equal(await fs.readFile(path.join(f.target.authDir, 'creds.json'), 'utf8'), '{"registered":true}');
  f.setConnect(true);
  await runWorkflow(f.gateway, async () => { throw new Error('must not pair'); }, { ...opts(), recover: true });
  assert.equal(await readJournal(operationDir(f.target), f.target), undefined);
});
test('gateway identity change leaves recovery record; later recovery rolls back', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await assert.rejects(runWorkflow(f.gateway, async args => { await success(args); f.breakIdentity(); throw new HelperError('GATEWAY_CHANGED', 'changed during pairing'); }, opts()), { code: 'RECOVERY_REQUIRED' });
  assert.ok(await readJournal(operationDir(f.target), f.target));
  f.resetIdentity();
  await runWorkflow(f.gateway, success, { ...opts(), recover: true });
  assert.deepEqual(await fs.readdir(f.target.authDir), []);
});
test('gateway restart after completed pairing preserves registration for later handoff', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await assert.rejects(runWorkflow(f.gateway, async args => { await success(args); f.breakIdentity(); }, opts()), { code: 'GATEWAY_CHANGED' });
  assert.equal((await readJournal(operationDir(f.target), f.target))?.phase, 'paired');
  f.resetIdentity();
  await runWorkflow(f.gateway, async () => { assert.fail('must not pair again'); }, { ...opts(), recover: true });
  assert.equal(await fs.readFile(path.join(f.target.authDir, 'creds.json'), 'utf8'), '{"registered":true}');
});
test('unsafe socket cleanup never restores files or starts runtime', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await assert.rejects(runWorkflow(f.gateway, async args => { await success(args); throw new HelperError('UNSAFE_CLEANUP', 'unsafe'); }, opts()), { code: 'UNSAFE_CLEANUP' });
  assert.ok(f.locks.has(f.target.authDir)); assert.ok(!f.calls.includes('start:sales'));
  assert.equal((await readRegular(path.join(f.target.authDir, 'creds.json'))).toString(), '{"registered":true}');
});
test('concurrent helper cannot stop an account already owned by another helper', async t => {
  const f = await fixture(); t.after(f.cleanup);
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  const first = runWorkflow(f.gateway, async args => { entered(); await gate; await success(args); }, opts());
  await ready;
  await assert.rejects(runWorkflow(f.gateway, success, opts()), { code: 'LOCK_BUSY' });
  release(); await first;
  assert.equal(f.calls.filter(c => c === 'stop:sales').length, 1);
});
test('unknown file content is refused before stopping the account', async t => {
  const f = await fixture(); t.after(f.cleanup); await secureDir(f.target.authDir);
  await atomicWrite(path.join(f.target.authDir, 'oauth.json'), '{}');
  await assert.rejects(runWorkflow(f.gateway, success, { ...opts(), relink: true }), { code: 'UNKNOWN_AUTH_CONTENT' });
  assert.ok(!f.calls.includes('stop:sales'));
});
