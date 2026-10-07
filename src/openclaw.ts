import fs from 'node:fs/promises';
import path from 'node:path';
import { constants, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { BASELINE, BASELINE_VERSION, PLUGIN_VERSION, BAILEYS_VERSION } from './baseline.js';
import { HelperError, requireThat } from './errors.js';
import { assertSafePath, exists, readRegular } from './files.js';
import type { Options } from './options.js';
import type { Gateway, Target, Lease, AccountStatus } from './types.js';
import { fetchWhatsAppWebVersion, type VersionFetch } from './wa-version.js';

// This is an intentionally narrow adapter, not a promise of compatibility with future internals.
type Module = Record<string, any>;
export async function verifyArtifact(root: string, key: keyof typeof BASELINE): Promise<string> {
  const artifact = BASELINE[key]; const p = path.join(root, artifact.path);
  const actual = createHash('sha256').update(await fs.readFile(p)).digest('hex');
  requireThat(actual === artifact.sha256, 'ARTIFACT_MISMATCH', `安装包与适配基线不一致：${artifact.path}`);
  return p;
}
async function importArtifact(root: string, key: keyof typeof BASELINE): Promise<Module> {
  return import(pathToFileURL(await verifyArtifact(root, key)).href);
}
export async function findPackageRoot(start: string, name: string): Promise<string> {
  let dir = (await fs.stat(start)).isDirectory() ? start : path.dirname(start);
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    if (await exists(pkg)) {
      const data = JSON.parse(await fs.readFile(pkg, 'utf8'));
      if (data.name === name) return fs.realpath(dir);
    }
    const parent = path.dirname(dir);
    requireThat(parent !== dir, 'INSTALL_NOT_FOUND', `无法定位 ${name} 安装目录。`); dir = parent;
  }
}
export async function findBinary(explicit?: string): Promise<string> {
  const candidates = explicit ? [path.resolve(explicit)] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(p => path.join(p, 'openclaw'));
  for (const p of candidates) {
    try { await fs.access(p, constants.X_OK); return await fs.realpath(p); } catch {}
  }
  throw new HelperError('OPENCLAW_NOT_FOUND', '未找到 OpenClaw；请使用 --openclaw-bin 指定可执行文件。');
}
export function assertDefaultProfile(options: Options, env = process.env): void {
  requireThat(options.profile || !env.OPENCLAW_PROFILE?.trim() || env.OPENCLAW_PROFILE === 'default', 'PROFILE_CONFLICT', '继承环境指向命名 profile，请显式指定 --profile。');
  requireThat(!env.OPENCLAW_CONTAINER && !env.OPENCLAW_DOCKER, 'REMOTE_UNSUPPORTED', '首版仅支持本机直接安装。');
}
export function validateHello(hello: any, target: Pick<Target, 'stateDir' | 'configPath'>, expectedGateway: string, actualGateway: string): string {
  requireThat(hello?.server?.version === BASELINE_VERSION, 'GATEWAY_VERSION', `Gateway 报告版本 ${String(hello?.server?.version ?? '未知')}，要求 ${BASELINE_VERSION}。`);
  requireThat(expectedGateway.length > 0 && actualGateway === expectedGateway, 'GATEWAY_CHANGED', 'Gateway 进程已重启或监听身份变化；停止本次交接，请使用 --recover。');
  requireThat(typeof hello.snapshot?.stateDir === 'string' && typeof hello.snapshot?.configPath === 'string', 'IDENTITY_UNVERIFIED', 'Gateway 未返回可验证的状态目录和配置路径。');
  requireThat(realpathSync(hello.snapshot.stateDir) === realpathSync(target.stateDir) && realpathSync(hello.snapshot.configPath) === realpathSync(target.configPath), 'IDENTITY_MISMATCH', '本地配置与 Gateway 不属于同一实例。');
  requireThat(hello.auth?.scopes?.includes('operator.admin'), 'ADMIN_REQUIRED', '需要已有的 operator.admin 权限。');
  for (const method of ['channels.stop', 'channels.start', 'channels.status']) requireThat(hello.features?.methods?.includes(method), 'RPC_UNSUPPORTED', 'Gateway 缺少账号级生命周期接口。');
  return expectedGateway;
}
export function accountStatus(result: any, account: string): AccountStatus {
  const entries = result?.channelAccounts?.whatsapp;
  const entry = Array.isArray(entries) ? entries.find((a: any) => a.accountId === account) : undefined;
  requireThat(entry && typeof entry.running === 'boolean', 'ACCOUNT_STATUS_UNKNOWN', '无法获取目标账号的实时运行状态。');
  return { running: entry.running, connected: entry.connected === true };
}
export function assertAccountStopped(status: AccountStatus): void {
  requireThat(!status.running, 'ACCOUNT_RESUMED', '目标账号已重新启动；立即停止配对并恢复操作。');
}
export async function assertLocalSocketUser(url: URL): Promise<string> {
  const port = Number(url.port || (url.protocol === 'wss:' ? 443 : 80));
  const rows = (await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(p => fs.readFile(p, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; })))).join('\n').split('\n');
  const listeners = rows.map(line => line.trim().split(/\s+/)).filter(fields => fields[3] === '0A' && Number.parseInt(fields[1]?.split(':')[1] ?? '', 16) === port);
  const uid = process.getuid?.();
  requireThat(uid !== undefined && listeners.length > 0 && listeners.every(fields => Number(fields[7]) === uid), 'GATEWAY_USER', '无法确认本机 Gateway 监听端口属于当前用户。');
  const inodes = new Set(listeners.map(fields => fields[9]).filter(Boolean));
  const pids = new Set<string>();
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const fdDir = `/proc/${entry}/fd`;
    let fds: string[];
    try { fds = await fs.readdir(fdDir); } catch { continue; }
    for (const fd of fds) {
      let link: string;
      try { link = await fs.readlink(path.join(fdDir, fd)); } catch { continue; }
      const match = /^socket:\[(\d+)\]$/.exec(link);
      if (!match || !inodes.has(match[1])) continue;
      try {
        const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        const startTime = fields[19];
        if (startTime) pids.add(`${entry}:${startTime}`);
      } catch {}
      break;
    }
  }
  requireThat(pids.size > 0, 'GATEWAY_USER', '无法确定本机 Gateway 监听进程身份。');
  return [...pids].sort().join(',');
}
export async function connectOpenClaw(options: Options): Promise<Gateway> {
  requireThat(process.platform === 'linux', 'PLATFORM_UNSUPPORTED', '实际配对与 --check 仅支持 Linux 本机；构建和单元测试可在其他系统执行。');
  assertDefaultProfile(options);
  const binary = await findBinary(options.binary);
  const coreRoot = await findPackageRoot(binary, 'openclaw');
  const corePkg = JSON.parse(await fs.readFile(path.join(coreRoot, 'package.json'), 'utf8'));
  requireThat(corePkg.version === BASELINE_VERSION, 'VERSION_UNSUPPORTED', `当前 OpenClaw ${corePkg.version} 未列入已审查基线；未修改账号或凭据。`);
  const profile = await importArtifact(coreRoot, 'profile');
  // Apply the installed CLI's profile semantics before importing modules that capture paths.
  profile.n({ profile: options.profile ?? 'default', env: process.env });
  const paths = await importArtifact(coreRoot, 'paths');
  const stateDir = await fs.realpath(paths.v());
  const configPath = await fs.realpath(paths.s());
  await readRegular(configPath);
  const configModule = await importArtifact(coreRoot, 'config');
  const snapshot = await configModule.u({ observe: false, recoverSuspicious: false, isolateEnv: true });
  requireThat(snapshot.exists && snapshot.valid, 'CONFIG_INVALID', '目标配置不存在或无效。');
  const config = snapshot.config;
  requireThat(config.gateway?.mode !== 'remote', 'REMOTE_UNSUPPORTED', '不支持远程 Gateway；请在 Gateway 主机运行。');
  const registry = await importArtifact(coreRoot, 'registry');
  const report = registry.buildPluginRegistrySnapshotReport({ config, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const plugins = report.plugins.filter((p: any) => p.id === 'whatsapp' && p.enabled && p.status !== 'error' && p.status !== 'disabled');
  requireThat(plugins.length === 1 && typeof plugins[0].source === 'string', 'PLUGIN_UNVERIFIED', '无法唯一定位已启用的官方 WhatsApp 插件。');
  const pluginRoot = await findPackageRoot(plugins[0].rootDir ?? plugins[0].source, '@openclaw/whatsapp');
  const pluginPkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'));
  requireThat(pluginPkg.version === PLUGIN_VERSION && pluginPkg.dependencies?.baileys === BAILEYS_VERSION, 'PLUGIN_VERSION', 'WhatsApp 插件或 Baileys 版本不符合 2026.7.1-2 基线。');
  const pluginRequire = createRequire(path.join(pluginRoot, 'package.json'));
  const baileysRoot = await findPackageRoot(pluginRequire.resolve('baileys'), 'baileys');
  requireThat(JSON.parse(await fs.readFile(path.join(baileysRoot, 'package.json'), 'utf8')).version === BAILEYS_VERSION, 'BAILEYS_VERSION', '插件实际解析的 Baileys 版本不符。');
  await verifyArtifact(pluginRoot, 'authFiles');
  const coreRequire = createRequire(path.join(coreRoot, 'package.json'));
  const proxyRuntime = await import(pathToFileURL(coreRequire.resolve('openclaw/plugin-sdk/fetch-runtime')).href);
  const agent = proxyRuntime.createNodeProxyAgent({ mode: 'env', targetUrl: 'https://mmg.whatsapp.net/', protocol: 'https' });
  const fetchAgent = proxyRuntime.createHttp1EnvHttpProxyAgent();
  const undiciFetch = coreRequire('undici').fetch as VersionFetch;
  const resolveWhatsAppVersion = () => fetchWhatsAppWebVersion(undiciFetch, fetchAgent);
  // Mirror OpenClaw's SDK resolution for external plugins without installing into their tree.
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('openclaw/plugin-sdk/') && context.parentURL?.startsWith(pathToFileURL(pluginRoot + path.sep).href)) {
      return { url: pathToFileURL(coreRequire.resolve(specifier)).href, shortCircuit: true };
    }
    return next(specifier, context);
  }});
  let accounts: Module;
  try { accounts = await importArtifact(pluginRoot, 'accounts'); } finally { hook.deregister(); }
  const configured = config.channels?.whatsapp;
  requireThat(configured && configured.enabled !== false, 'ACCOUNT_DISABLED', 'WhatsApp 通道未配置或已禁用。');
  requireThat(configured.accounts ? Object.hasOwn(configured.accounts, options.account) : options.account === 'default', 'ACCOUNT_MISSING', '目标账号未配置；请先在 OpenClaw 中添加账号。');
  const account = accounts.a({ cfg: config, accountId: options.account });
  requireThat(account.enabled && !account.isLegacyAuthDir, 'ACCOUNT_UNSUPPORTED', '账号已禁用或使用旧版共享凭据目录。');
  await assertSafePath(account.authDir);
  const authDir = path.resolve(account.authDir);
  requireThat(authDir !== stateDir && authDir !== path.dirname(configPath), 'UNSAFE_AUTH_DIR', '凭据目录不能与实例根目录重合。');
  const rpcModule = await importArtifact(coreRoot, 'rpc');
  await verifyArtifact(coreRoot, 'rpcImpl');
  const gatewayClientModule = await importArtifact(coreRoot, 'gatewayClient');
  const url = new URL(rpcModule.buildGatewayConnectionDetails({ config }).url);
  requireThat(['ws:', 'wss:'].includes(url.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && !url.username && !url.password && !url.search, 'REMOTE_UNSUPPORTED', 'Gateway 必须使用无敏感查询参数的本机回环地址。');
  const target: Target = { binary, coreRoot, pluginRoot, profile: options.profile ?? 'default', account: options.account, stateDir, configPath, authDir, gatewayUrl: url.href, coreVersion: corePkg.version, pluginVersion: pluginPkg.version, baileysVersion: BAILEYS_VERSION };
  const gatewayIdentity = await assertLocalSocketUser(url);
  rpcModule.testing.setDepsForTests({ createGatewayClient(clientOptions: any) {
    let hello: any;
    const client = new gatewayClientModule.t({ ...clientOptions, onHelloOk(value: any) {
      hello = value;
      clientOptions.onHelloOk?.(value);
    }});
    return {
      start: () => client.start(),
      stop: () => client.stop(),
      stopAndWait: (opts: any) => client.stopAndWait(opts),
      getConnectionMetadata: () => client.getConnectionMetadata(),
      async request(method: string, params?: unknown, requestOptions?: unknown) {
        if (method !== 'connect') {
          const currentGatewayIdentity = await assertLocalSocketUser(url);
          validateHello(hello, target, gatewayIdentity, currentGatewayIdentity);
        }
        return client.request(method, params, requestOptions);
      },
    };
  }});
  async function rpc(method: string, params: object = {}): Promise<any> {
    try {
      return await rpcModule.callGateway({ config, method, params, scopes: ['operator.admin'], timeoutMs: 15_000, deviceIdentity: null, mode: 'backend' });
    } catch (e) { if (e instanceof HelperError) throw e; throw new HelperError('GATEWAY_RPC', `Gateway ${method} 调用失败；未输出原始认证错误。`); }
  }
  const lockModule = await importArtifact(coreRoot, 'lock');
  const gateway: Gateway = {
    target, resolveWhatsAppVersion,
    socketOptions: { agent, fetchAgent },
    async status() { return accountStatus(await rpc('channels.status', { probe: false }), target.account); },
    async assertIdentity() {
      const status = accountStatus(await rpc('channels.status', { probe: false }), target.account);
      assertAccountStopped(status);
    },
    async stop() {
      const response = await rpc('channels.stop', { channel: 'whatsapp', accountId: target.account });
      requireThat(response.channel === 'whatsapp' && response.accountId === target.account && response.stopped === true, 'STOP_FAILED', '目标账号尚未完成停止。');
      requireThat(!(await gateway.status()).running, 'STOP_FAILED', '目标账号仍在运行。');
    },
    async start() {
      const response = await rpc('channels.start', { channel: 'whatsapp', accountId: target.account });
      requireThat(response.channel === 'whatsapp' && response.accountId === target.account && response.started === true, 'START_FAILED', '凭据已保留，但目标账号未启动；请检查配置及生命周期状态。');
    },
    async acquireLock(resource): Promise<Lease> {
      let handle: any;
      try { handle = await lockModule.r(resource, { retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 }, stale: 300_000, staleRecovery: 'remove-if-unchanged' }); }
      catch { throw new HelperError('LOCK_BUSY', '另一个进程持有目标锁；未强制解锁。'); }
      const original = await fs.lstat(handle.lockPath); const bytes = await fs.readFile(handle.lockPath);
      let released = false;
      const lease: Lease = {
        async assertOwned() {
          requireThat(!released, 'LOCK_LOST', '凭据锁已释放。');
          const current = await fs.lstat(handle.lockPath).catch(() => null);
          requireThat(current?.isFile() && current.ino === original.ino && current.dev === original.dev && Buffer.compare(await fs.readFile(handle.lockPath), bytes) === 0, 'LOCK_LOST', '凭据所有权已变化，停止写入。');
        },
        async release() { if (!released) { await lease.assertOwned(); await handle.release(); released = true; } },
      };
      return lease;
    },
  };
  await gateway.status();
  return gateway;
}
