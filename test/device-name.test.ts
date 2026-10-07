import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { patchBaileysSource } from '../src/device-name.js';

test('device name patch is exact, repeatable, and leaves pairing browser identity alone', async () => {
  const source = await fs.readFile(new URL('../node_modules/baileys/lib/Utils/validate-connection.js', import.meta.url), 'utf8');
  const patched = patchBaileysSource(source);
  assert.ok(patched.includes('os: config.helperDeviceName ?? config.browser[0],'));
  assert.equal(patchBaileysSource(patched), patched);
  assert.equal(patched.replace('os: config.helperDeviceName ?? config.browser[0],', 'os: config.browser[0],'), source);
  assert.throws(() => patchSource('os: config.browser[0],'));
  const socket = await fs.readFile(new URL('../node_modules/baileys/lib/Socket/socket.js', import.meta.url), 'utf8');
  assert.ok(socket.includes('`${browser[1]} (${browser[0]})`'));
});
