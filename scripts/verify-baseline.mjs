#!/usr/bin/env node
// Run against extracted/installed official artifacts, never a live profile.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { BASELINE, BASELINE_VERSION, PLUGIN_VERSION, BAILEYS_VERSION } from '../dist/baseline.js';

const run = promisify(execFile);
const [coreArg, pluginArg] = process.argv.slice(2);
if (!coreArg || !pluginArg) throw new Error('Usage: npm run verify:baseline -- <openclaw-package-root> <whatsapp-package-root>');
const core = await fs.realpath(coreArg); const plugin = await fs.realpath(pluginArg);
const corePackage = JSON.parse(await fs.readFile(path.join(core, 'package.json'), 'utf8'));
assert.equal(corePackage.version, BASELINE_VERSION, `Unrecognized core version: ${corePackage.version}`);
const pluginPackage = JSON.parse(await fs.readFile(path.join(plugin, 'package.json'), 'utf8'));
assert.equal(pluginPackage.version, PLUGIN_VERSION);
assert.equal(pluginPackage.dependencies?.baileys, BAILEYS_VERSION);
for (const item of Object.values(BASELINE)) {
  const bytes = await fs.readFile(path.join(item.package === 'core' ? core : plugin, item.path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, item.path);
}
console.log('Official artifact hashes match.');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wa-baseline-')));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OPENCLAW_')));
env.HOME = temp; env.OPENCLAW_HOME = temp;
const moduleURL = key => pathToFileURL(path.join(core, BASELINE[key].path)).href;
async function child(code, extra = {}) {
  const result = await run(process.execPath, ['--input-type=module', '-e', code], { env: { ...env, ...extra }, timeout: 60_000, maxBuffer: 2_000_000 });
  if (result.stdout.trim()) console.log(result.stdout.trim());
}
try {
  for (const profile of ['default', 'lmtax', 'company2']) {
    await child(`
      import assert from 'node:assert/strict';
      const profile = await import(${JSON.stringify(moduleURL('profile'))});
      profile.n({ profile: ${JSON.stringify(profile)}, env: process.env });
      const paths = await import(${JSON.stringify(moduleURL('paths'))});
      assert.equal(paths.v(), ${JSON.stringify(path.join(temp, profile === 'default' ? '.openclaw' : `.openclaw-${profile}`))});
      console.log('profile path: ${profile} OK');
    `);
  }
  await child(`
    import assert from 'node:assert/strict';
    const profile = await import(${JSON.stringify(moduleURL('profile'))}); profile.n({ profile: 'lmtax', env: process.env });
    const paths = await import(${JSON.stringify(moduleURL('paths'))});
    assert.equal(paths.v(), ${JSON.stringify(path.join(temp, 'custom-state'))});
    assert.equal(paths.s(), ${JSON.stringify(path.join(temp, 'custom-config.json'))});
    console.log('explicit state/config overrides OK');
  `, { OPENCLAW_STATE_DIR: path.join(temp, 'custom-state'), OPENCLAW_CONFIG_PATH: path.join(temp, 'custom-config.json') });
  const lock = await import(moduleURL('lock'));
  const resource = path.join(temp, 'owner'); await fs.mkdir(resource);
  const lease = await lock.r(resource, { retries: { retries: 0, minTimeout: 1, maxTimeout: 1 }, stale: 300000, staleRecovery: 'remove-if-unchanged' });
  try {
    await child(`
      import assert from 'node:assert/strict';
      const lock = await import(${JSON.stringify(moduleURL('lock'))});
      await assert.rejects(lock.r(${JSON.stringify(resource)}, { retries: { retries: 0, minTimeout: 1, maxTimeout: 1 }, stale: 300000, staleRecovery: 'remove-if-unchanged' }), { code: 'file_lock_timeout' });
      console.log('cross-process lock excludes second writer OK');
    `);
  } finally { await lease.release(); }
  const configDir = path.join(temp, '.openclaw'); await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'accounts.json'), JSON.stringify({ accounts: { sales: { enabled: true }, support: { enabled: false, authDir: path.join(temp, 'custom-auth') } } }));
  await fs.writeFile(path.join(configDir, 'openclaw.json'), JSON.stringify({ gateway: { mode: 'local' }, channels: { whatsapp: { $include: './accounts.json' } } }));
  await child(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { createRequire, registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const io = await import(${JSON.stringify(moduleURL('config'))});
    const before = (await fs.readdir(${JSON.stringify(configDir)})).sort();
    const snapshot = await io.u({ observe: false, recoverSuspicious: false, skipPluginValidation: true, isolateEnv: true });
    assert.ok(snapshot.exists && snapshot.valid);
    const req = createRequire(${JSON.stringify(path.join(core, 'package.json'))});
    const proxy = await import(pathToFileURL(req.resolve('openclaw/plugin-sdk/fetch-runtime')).href);
    const agent = proxy.createNodeProxyAgent({mode:'env',targetUrl:'https://mmg.whatsapp.net/',protocol:'https'});
    const fetchAgent = proxy.createHttp1EnvHttpProxyAgent();
    agent?.destroy(); await fetchAgent?.close();
    const hook = registerHooks({ resolve(s, ctx, next) { if(s.startsWith('openclaw/plugin-sdk/') && ctx.parentURL?.startsWith(${JSON.stringify(pathToFileURL(plugin + path.sep).href)})) return { url: pathToFileURL(req.resolve(s)).href, shortCircuit: true }; return next(s,ctx); } });
    const accounts = await import(${JSON.stringify(pathToFileURL(path.join(plugin, BASELINE.accounts.path)).href)});
    const sales = accounts.a({cfg:snapshot.config,accountId:'sales'});
    assert.equal(sales.authDir, ${JSON.stringify(path.join(configDir, 'credentials', 'whatsapp', 'sales'))});
    assert.equal(accounts.a({cfg:snapshot.config,accountId:'support'}).enabled, false);
    assert.equal(accounts.a({cfg:snapshot.config,accountId:'support'}).authDir, ${JSON.stringify(path.join(temp, 'custom-auth'))});
    assert.deepEqual((await fs.readdir(${JSON.stringify(configDir)})).sort(), before);
    hook.deregister(); console.log('installed config includes + account resolver + proxy constructors + read-only filesystem OK');
  `);
  await child(`
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import fs from 'node:fs/promises';
    const req = createRequire(${JSON.stringify(path.join(core, 'package.json'))});
    const { WebSocketServer } = req('ws');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise(r => server.once('listening', r));
    const calls = [];
    server.on('connection', ws => {
      ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'test-nonce', ts: Date.now() } }));
      ws.on('message', bytes => {
        const msg = JSON.parse(bytes.toString());
        calls.push(msg.method);
        const payload = msg.method === 'connect' ? { type: 'hello-ok', protocol: 4, server: { version: ${JSON.stringify(BASELINE_VERSION)}, bootId: 'fixture-boot', connId: 'fixture-connection' }, features: { methods: ['channels.status','channels.stop','channels.start'], events: [] }, snapshot: { stateDir: ${JSON.stringify(configDir)}, configPath: ${JSON.stringify(path.join(configDir, 'openclaw.json'))} }, auth: { scopes: ['operator.admin'], role: 'operator' }, policy: { tickIntervalMs: 30000, maxPayload: 1000000, maxBufferedBytes: 1000000 } } : { channelAccounts: { whatsapp: [{ accountId: 'sales', running: false, connected: false }] } };
        ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload }));
      });
    });
    const rpc = await import(${JSON.stringify(moduleURL('rpc'))});
    const gatewayClientModule = await import(${JSON.stringify(moduleURL('gatewayClient'))});
    const { validateHello } = await import(${JSON.stringify(new URL('../dist/openclaw.js', import.meta.url).href)});
    const config = { gateway: { mode: 'local', port: server.address().port, auth: { mode: 'token', token: 'fixture-only-token' } } };
    assert.equal(new URL(rpc.buildGatewayConnectionDetails({ config }).url).port, String(server.address().port));
    try {
      let boot;
      const target = { stateDir: ${JSON.stringify(configDir)}, configPath: ${JSON.stringify(path.join(configDir, 'openclaw.json'))} };
      rpc.testing.setDepsForTests({ createGatewayClient(options) {
        let hello;
        const client = new gatewayClientModule.t({ ...options, onHelloOk(value) { hello=value; options.onHelloOk?.(value); } });
        return { start:()=>client.start(), stop:()=>client.stop(), stopAndWait:o=>client.stopAndWait(o), getConnectionMetadata:()=>client.getConnectionMetadata(), request(method,params,requestOptions) { if(method!=='connect') boot=validateHello(hello,target,boot??'fixture:1','fixture:1'); return client.request(method,params,requestOptions); } };
      }});
      const status = await rpc.callGateway({ config, method: 'channels.status', params: {probe:false}, scopes: ['operator.admin'], deviceIdentity: null, timeoutMs: 3000, mode: 'backend' });
      assert.equal(status.channelAccounts.whatsapp[0].connected, false);
      assert.ok(calls.includes('channels.status'));
      console.log('official Gateway call client handshake + status RPC OK');
      if (process.platform === 'linux') {
        const { connectOpenClaw } = await import(${JSON.stringify(new URL('../dist/openclaw.js', import.meta.url).href)});
        const fixtureConfig = {...config, channels:{whatsapp:{enabled:true,accounts:{sales:{enabled:true}}}},plugins:{load:{paths:[${JSON.stringify(plugin)}]},entries:{whatsapp:{enabled:true}}}};
        await fs.writeFile(${JSON.stringify(path.join(configDir, 'openclaw.json'))}, JSON.stringify(fixtureConfig), {mode:0o600});
        const gateway = await connectOpenClaw({account:'sales',binary:${JSON.stringify(path.join(core, 'openclaw.mjs'))},check:true,relink:false,recover:false});
        assert.equal(gateway.target.authDir, ${JSON.stringify(path.join(configDir, 'credentials', 'whatsapp', 'sales'))});
        assert.equal((await gateway.status()).running, false);
        assert.ok(!calls.includes('channels.stop'));
        assert.equal(await fs.stat(gateway.target.authDir).then(()=>true,()=>false),false);
        gateway.socketOptions.agent?.destroy(); await gateway.socketOptions.fetchAgent?.close();
        console.log('Linux complete installation discovery + identity + read-only preflight OK');
      }
    } finally { for(const client of server.clients) client.terminate(); await new Promise(r => server.close(r)); }
  `);
  console.log('Baseline contract checks passed; these do not constitute real-device acceptance.');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
