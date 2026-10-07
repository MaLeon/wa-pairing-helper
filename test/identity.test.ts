import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.js';
import { validateHello, accountStatus, assertAccountStopped } from '../src/openclaw.js';
import { targetKey, restoreAuth, secureDir, atomicWrite } from '../src/files.js';
import path from 'node:path';
import fs from 'node:fs/promises';
test('authenticated hello must prove paths, version, admin scope and local Gateway process identity', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const hello = { server: { version: '2026.7.1-2', connId: 'connection-1' }, snapshot: { stateDir: f.root, configPath: f.target.configPath }, auth: { scopes: ['operator.admin'] }, features: { methods: ['channels.stop', 'channels.start', 'channels.status'] } };
  assert.equal(validateHello(hello, f.target, '123:456', '123:456'), '123:456');
  assert.throws(() => validateHello(hello, f.target, '123:456', '789:456'), { code: 'GATEWAY_CHANGED' });
  assert.throws(() => validateHello({ ...hello, server: { ...hello.server, version: '2026.9.4' } }, f.target, '123:456', '123:456'), { code: 'GATEWAY_VERSION' });
  assert.throws(() => validateHello({ ...hello, auth: { scopes: ['operator.read'] } }, f.target, '123:456', '123:456'), { code: 'ADMIN_REQUIRED' });
  assert.throws(() => validateHello({ ...hello, snapshot: {} }, f.target, '123:456', '123:456'), { code: 'IDENTITY_UNVERIFIED' });
  assert.notEqual(targetKey(f.target.authDir), targetKey(path.join(f.root, 'other-profile', 'sales')));
});
test('account status does not treat started as provider connectivity', () => {
  assert.deepEqual(accountStatus({ channelAccounts: { whatsapp: [{ accountId: 'sales', running: true, connected: false }] } }, 'sales'), { running: true, connected: false });
  assert.throws(() => accountStatus({ channelAccounts: { whatsapp: [] } }, 'sales'));
  assert.throws(() => assertAccountStopped({ running: true, connected: false }), { code: 'ACCOUNT_RESUMED' });
  assert.doesNotThrow(() => assertAccountStopped({ running: false, connected: false }));
});
test('corrupt backup never clears live credentials', async t => {
  const f = await fixture(); t.after(f.cleanup); await secureDir(f.target.authDir);
  const backup = path.join(f.root, 'backup'); await secureDir(backup);
  await atomicWrite(path.join(f.target.authDir, 'creds.json'), 'live'); await atomicWrite(path.join(backup, 'creds.json'), 'corrupted');
  await assert.rejects(restoreAuth(f.target.authDir, backup, { 'creds.json': '0'.repeat(64) }, async () => {}), { code: 'BACKUP_INVALID' });
  assert.equal(await fs.readFile(path.join(f.target.authDir, 'creds.json'), 'utf8'), 'live');
});
