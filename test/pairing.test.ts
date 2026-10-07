import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createPair, type PairSocket } from '../src/pairing.js';
import { createAuthState, WriteQueue } from '../src/auth-state.js';
import { secureDir, readRegular } from '../src/files.js';
import { fixture } from './fixture.js';
import { HelperError } from '../src/errors.js';

const testVersion = async (): Promise<[number, number, number]> => [2, 3000, 1043857760];

test('pair waits for QR readiness, requests once, handles 515, then drains and closes', async t => {
  const f = await fixture(); t.after(f.cleanup); await secureDir(f.target.authDir);
  let sockets = 0; let requests = 0; let closes = 0; const codes: string[] = []; const versions: number[][] = [];
  const pair = createPair({ resolveVersion: testVersion, timeoutMs: 1_000, closeTimeoutMs: 100, socket(config) {
    versions.push(config.version as number[]);
    assert.equal((config as any).helperDeviceName, 'AI Bot');
    const generation = ++sockets; const ev = new EventEmitter(); let closed = false;
    const sock = { ev, ws: { get isClosed() { return closed; } },
      async end() { closed = true; closes++; },
      async requestPairingCode() {
        requests++;
        queueMicrotask(() => { config.auth!.creds.registered = true; config.auth!.creds.me = { id: '60123456789@s.whatsapp.net', name: 'test' }; ev.emit('creds.update', {}); ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } }); });
        return 'ABCDEFGH';
      },
    } as unknown as PairSocket;
    queueMicrotask(() => {
      if (generation === 1) {
        ev.emit('connection.update', { connection: 'connecting' }); assert.equal(requests, 0);
        ev.emit('connection.update', { qr: 'one' }); ev.emit('connection.update', { qr: 'two' });
      } else ev.emit('connection.update', { connection: 'open' });
    });
    return sock;
  }});
  await pair({ authDir: f.target.authDir, phone: '60123456789', deviceName: 'AI Bot', signal: new AbortController().signal, assertOwned: async () => {}, showCode: c => codes.push(c) });
  assert.equal(sockets, 2); assert.equal(requests, 1); assert.equal(closes, 2); assert.deepEqual(codes, ['ABCD-EFGH']); assert.deepEqual(versions, [[2, 3000, 1043857760], [2, 3000, 1043857760]]);
  assert.equal(JSON.parse((await readRegular(path.join(f.target.authDir, 'creds.json'))).toString()).registered, true);
});
test('pair timeout closes socket and never logs provider data', async t => {
  const f = await fixture(); t.after(f.cleanup); await secureDir(f.target.authDir); let closed = false;
  const pair = createPair({ resolveVersion: testVersion, timeoutMs: 15, closeTimeoutMs: 100, socket() { return { ev: new EventEmitter(), ws: { get isClosed() { return closed; } }, async end() { closed = true; } } as unknown as PairSocket; } });
  await assert.rejects(pair({ authDir: f.target.authDir, phone: '60123456789', signal: new AbortController().signal, assertOwned: async () => {}, showCode() { assert.fail(); } }), { code: 'PAIR_TIMEOUT' });
  assert.equal(closed, true);
});
test('515 reconnect attempts are bounded and never generate a second code', async t => {
  const f = await fixture(); t.after(f.cleanup); await secureDir(f.target.authDir);
  let sockets = 0; let requests = 0; let closes = 0;
  const pair = createPair({ resolveVersion: testVersion, timeoutMs: 1_000, closeTimeoutMs: 100, socket() {
    const ev = new EventEmitter(); let closed = false; const generation = ++sockets;
    const disconnect = () => ev.emit('connection.update', {connection:'close',lastDisconnect:{error:{output:{statusCode:515}}}});
    queueMicrotask(() => generation === 1 ? ev.emit('connection.update', {qr:'ready'}) : disconnect());
    return {ev,ws:{get isClosed(){return closed;}},async end(){closed=true;closes++;},async requestPairingCode(){requests++;queueMicrotask(disconnect);return 'ABCDEFGH';}} as unknown as PairSocket;
  }});
  await assert.rejects(pair({authDir:f.target.authDir,phone:'60123456789',signal:new AbortController().signal,assertOwned:async()=>{},showCode(){}}), {code:'PAIR_CONNECTION_CLOSED'});
  assert.equal(sockets,3); assert.equal(requests,1); assert.equal(closes,3);
});
test('pairing refusal and network loss close the socket without reporting success', async t => {
  for (const statusCode of [401, 428]) {
    const f = await fixture(); t.after(f.cleanup); await secureDir(f.target.authDir); let closed = false;
    const pair = createPair({resolveVersion:testVersion,timeoutMs:1_000,closeTimeoutMs:100,socket(){
      const ev = new EventEmitter();
      queueMicrotask(()=>ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode}}}}));
      return {ev,ws:{get isClosed(){return closed;}},async end(){closed=true;}} as unknown as PairSocket;
    }});
    await assert.rejects(pair({authDir:f.target.authDir,phone:'60123456789',signal:new AbortController().signal,assertOwned:async()=>{},showCode(){assert.fail();}}), {code:'PAIR_CONNECTION_CLOSED'});
    assert.equal(closed,true);
  }
});
test('abort and unconfirmed closure are distinguished', async t => {
  const f = await fixture(); t.after(f.cleanup); await secureDir(f.target.authDir); const abort = new AbortController();
  const pair = createPair({ resolveVersion: testVersion, timeoutMs: 500, closeTimeoutMs: 10, socket() { queueMicrotask(() => abort.abort()); return { ev: new EventEmitter(), ws: { isClosed: false }, async end() { await new Promise(() => {}); } } as unknown as PairSocket; } });
  await assert.rejects(pair({ authDir: f.target.authDir, phone: '60123456789', signal: abort.signal, assertOwned: async () => {}, showCode() {} }), { code: 'UNSAFE_CLEANUP' });
});
test('auth store round-trips binary Signal keys and serializes removal', async t => {
  const f = await fixture(); t.after(f.cleanup); await secureDir(f.target.authDir);
  const store = await createAuthState(f.target.authDir, async () => {}, () => {});
  await store.state.keys.set({ session: { 'a/b:c': Buffer.from([1, 2, 3]) } });
  const result = await store.state.keys.get('session', ['a/b:c']);
  assert.deepEqual(result['a/b:c'], Buffer.from([1, 2, 3]));
  await store.state.keys.set({ session: { 'a/b:c': null } });
  await store.saveCreds(); await store.queue.drain();
  assert.deepEqual(await fs.readdir(f.target.authDir), ['creds.json']);
  assert.equal((await fs.stat(path.join(f.target.authDir, 'creds.json'))).mode & 0o777, 0o600);
});
test('write failure latches, prevents subsequent writes, and remains observable at drain', async () => {
  let writes = 0; let failures = 0; const queue = new WriteQueue(() => failures++);
  const first = queue.run(async () => { throw new HelperError('DISK_FULL', 'failed'); });
  const second = queue.run(async () => { writes++; });
  await assert.rejects(first); await assert.rejects(second); await assert.rejects(queue.drain());
  assert.equal(writes, 0); assert.equal(failures, 1);
});
