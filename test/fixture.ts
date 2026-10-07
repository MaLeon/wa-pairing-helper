import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HelperError } from '../src/errors.js';
import type { Gateway, Target, Lease } from '../src/types.js';
export async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wa-pair-test-')));
  const target: Target = { binary: '/bin/openclaw', coreRoot: '/core', pluginRoot: '/plugin', profile: 'default', account: 'sales', stateDir: root, configPath: path.join(root, 'openclaw.json'), authDir: path.join(root, 'credentials', 'whatsapp', 'sales'), gatewayUrl: 'ws://127.0.0.1:18789/', coreVersion: '2026.7.1-2', pluginVersion: '2026.7.1', baileysVersion: '7.0.0-rc13' };
  await fs.writeFile(target.configPath, '{}', { mode: 0o600 });
  const calls: string[] = []; const locks = new Set<string>();
  let running = true; let connected = true; let identityValid = true; let connectAfterStart = true;
  const gateway: Gateway = {
    target,
    async assertIdentity() { if (!identityValid) throw new HelperError('GATEWAY_CHANGED', 'changed'); },
    async status() { await this.assertIdentity(); return { running, connected }; },
    async stop() { calls.push('stop:sales'); await this.assertIdentity(); running = false; connected = false; },
    async start() { calls.push('start:sales'); await this.assertIdentity(); running = true; connected = connectAfterStart; },
    async acquireLock(resource): Promise<Lease> {
      if (locks.has(resource)) throw new HelperError('LOCK_BUSY', 'busy');
      locks.add(resource); calls.push(`lock:${resource}`); let released = false;
      return { async assertOwned() { if (released || !locks.has(resource)) throw new HelperError('LOCK_LOST', 'lost'); }, async release() { locks.delete(resource); released = true; calls.push(`unlock:${resource}`); } };
    },
  };
  return { root, target, gateway, calls, locks, setRunning(v: boolean) { running = v; connected = v; }, breakIdentity() { identityValid = false; }, resetIdentity() { identityValid = true; }, setConnect(v: boolean) { connectAfterStart = v; }, async cleanup() { await fs.rm(root, { recursive: true, force: true }); } };
}
