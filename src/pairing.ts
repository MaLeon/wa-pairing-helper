import makeWASocket, { Browsers, type ConnectionState, type UserFacingSocketConfig } from 'baileys';
import pino from 'pino';
import { createAuthState } from './auth-state.js';
import { HelperError, requireThat } from './errors.js';
import type { Pair } from './types.js';

export type PairSocket = Pick<ReturnType<typeof makeWASocket>, 'ev' | 'ws' | 'end' | 'requestPairingCode'>;
export interface PairingDependencies { socket: (config: UserFacingSocketConfig) => PairSocket; resolveVersion: (dispatcher: unknown) => Promise<[number, number, number]>; timeoutMs: number; closeTimeoutMs: number; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function bounded<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HelperError(code, '连接关闭或持久化未按时完成；保留操作记录，请恢复。')), ms); })]); }
  finally { clearTimeout(timer); }
}
export function createPair(deps: Partial<PairingDependencies> = {}, transport: Partial<UserFacingSocketConfig> = {}): Pair {
  const socketFactory = deps.socket ?? makeWASocket;
  const resolveVersion = deps.resolveVersion ?? (async () => { throw new HelperError('WA_VERSION_UNAVAILABLE', '未配置 WhatsApp Web 协议版本获取器。'); });
  const timeoutMs = deps.timeoutMs ?? 180_000;
  const closeTimeoutMs = deps.closeTimeoutMs ?? 15_000;
  return async ({ authDir, phone, deviceName, signal, assertOwned, showCode }) => {
    const fatal = deferred<never>();
    // Mark handled even during setup/cleanup before a race is installed.
    void fatal.promise.catch(() => {});
    const abort = () => fatal.reject(new HelperError('CANCELLED', '配对已取消。'));
    let stopped = false;
    const guard = async () => { requireThat(!signal.aborted, 'CANCELLED', '配对已取消。'); await assertOwned(); };
    const auth = await createAuthState(authDir, guard, error => fatal.reject(error));
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => fatal.reject(new HelperError('PAIR_TIMEOUT', '配对等待超时；可稍后重新尝试。')), timeoutMs);
    let socket: PairSocket | undefined;
    let requested = false; let restarts = 0;
    let pendingRequest: Promise<void> | undefined;
    let onUpdate: ((state: Partial<ConnectionState>) => void) | undefined;
    const onCreds = () => { if (!stopped) void auth.saveCreds().catch(e => fatal.reject(e)); };
    const close = async () => {
      if (!socket) return;
      if (onUpdate) socket.ev.off('connection.update', onUpdate);
      const current = socket;
      // Baileys end() awaits WebSocket closure in this pinned version.
      await bounded(Promise.resolve(current.end(new Error('Pairing helper handoff'))), closeTimeoutMs, 'UNSAFE_CLEANUP');
      requireThat(current.ws.isClosed, 'UNSAFE_CLEANUP', 'WebSocket 未关闭；拒绝交出凭据锁。');
      current.ev.off('creds.update', onCreds);
      socket = undefined;
    };
    try {
      if (signal.aborted) abort();
      const version = await resolveVersion(transport.fetchAgent);
      for (;;) {
        await guard();
        const result = deferred<'open' | 'restart'>();
        socket = socketFactory({ ...transport, auth: auth.state, logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('Chrome'),
          ...(deviceName ? { helperDeviceName: deviceName } : {}),
          version, markOnlineOnConnect: false, syncFullHistory: false, printQRInTerminal: false,
          connectTimeoutMs: 30_000, defaultQueryTimeoutMs: 30_000 } as UserFacingSocketConfig);
        socket.ev.on('creds.update', onCreds);
        const current = socket;
        onUpdate = update => {
          if (stopped) return;
          // QR is the stronger readiness signal; it avoids the early 'connecting' race.
          if (update.qr && !auth.state.creds.registered && !requested) {
            requested = true;
            pendingRequest = (async () => {
              await guard();
              const code = await current.requestPairingCode(phone);
              if (stopped || signal.aborted) return;
              requireThat(/^[A-Z0-9]{8}$/.test(code), 'PAIR_CODE_INVALID', '关联码格式不符合预期。');
              showCode(`${code.slice(0, 4)}-${code.slice(4)}`);
            })().catch(error => { fatal.reject(error); });
          }
          if (update.connection === 'open') result.resolve('open');
          if (update.connection === 'close') {
            const error = update.lastDisconnect?.error as any;
            const code = error?.output?.statusCode;
            if (code === 515 && requested && ++restarts <= 2) result.resolve('restart');
            else {
              const transportCode = typeof error?.code === 'string' && /^[A-Z0-9_-]{1,48}$/.test(error.code) ? error.code : 'unknown';
              fatal.reject(new HelperError('PAIR_CONNECTION_CLOSED', `WhatsApp 连接失败或已注销（status=${String(code ?? 'none')}, code=${transportCode}）；未无限重试。`));
            }
          }
        };
        current.ev.on('connection.update', onUpdate);
        const outcome = await Promise.race([result.promise, fatal.promise]);
        await close();
        await bounded(pendingRequest ?? Promise.resolve(), closeTimeoutMs, 'UNSAFE_CLEANUP');
        await auth.queue.drain();
        if (outcome === 'restart') continue;
        requireThat(auth.state.creds.registered && auth.state.creds.me?.id, 'AUTH_NOT_REGISTERED', '连接已打开但凭据尚未完成注册。');
        await auth.saveCreds(); await auth.queue.drain(); await guard();
        return;
      }
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      stopped = true;
      // A cleanup failure is deliberately different from a completed, failed pairing.
      let cleanupError: unknown;
      try {
        await close();
        await bounded(pendingRequest ?? Promise.resolve(), closeTimeoutMs, 'UNSAFE_CLEANUP');
      } catch { cleanupError = new HelperError('UNSAFE_CLEANUP', 'Helper 连接未能确认关闭；保留凭据与恢复记录，禁止自动恢复账号。'); }
      auth.queue.seal();
      try { await bounded(auth.queue.drain(), closeTimeoutMs, 'UNSAFE_CLEANUP'); }
      catch (error) { cleanupError ??= error; }
      if (cleanupError) throw cleanupError;
    }
  };
}
