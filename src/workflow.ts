import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite, authFiles, backupAuth, clearAuth, exists, readRegular, restoreAuth, secureDir, syncDir, targetKey } from './files.js';
import { HelperError, requireThat } from './errors.js';
import type { Gateway, Lease, Pair, Target } from './types.js';

const phases = ['prepared', 'stopping', 'locked', 'backup-ready', 'pairing', 'paired', 'restoring', 'restored', 'handoff', 'done'] as const;
type Phase = typeof phases[number];
interface Journal {
  version: 1; id: string; account: string; profile: string; authDir: string; stateDir: string; configPath: string;
  phase: Phase; originalRunning: boolean; hashes?: Record<string, string>; createdAt: string;
}
export interface WorkflowOptions { relink: boolean; recover: boolean; phone?: string; deviceName?: string; signal: AbortSignal; showCode: (code: string) => void; log: (message: string) => void; connectTimeoutMs?: number; }
export function operationDir(target: Target): string { return path.join(target.stateDir, 'wa-pairing-helper', targetKey(target.authDir)); }
export async function readJournal(dir: string, target: Target): Promise<Journal | undefined> {
  const file = path.join(dir, 'pending.json');
  if (!await exists(file)) return undefined;
  const j = JSON.parse((await readRegular(file)).toString()) as Journal;
  requireThat(j.version === 1 && /^[a-f0-9-]{36}$/.test(j.id) && phases.includes(j.phase) && typeof j.originalRunning === 'boolean' &&
    j.account === target.account && j.profile === target.profile && j.authDir === target.authDir && j.stateDir === target.stateDir && j.configPath === target.configPath,
    'JOURNAL_INVALID', '恢复记录与当前目标不一致，拒绝修改。');
  if (j.hashes !== undefined) requireThat(j.hashes && !Array.isArray(j.hashes) && typeof j.hashes === 'object' && Object.values(j.hashes).every(h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h)), 'JOURNAL_INVALID', '备份哈希记录无效。');
  return j;
}
export async function runWorkflow(gateway: Gateway, pair: Pair, options: WorkflowOptions): Promise<void> {
  const target = gateway.target; const dir = operationDir(target); const journalPath = path.join(dir, 'pending.json');
  await secureDir(dir);
  const operationLease = await gateway.acquireLock(path.join(dir, 'operation'));
  let owner: Lease | undefined; let unsafeCleanup = false; let journal: Journal | undefined;
  const ownership = async () => { await operationLease.assertOwned(); requireThat(owner, 'NO_OWNER', '尚未获得凭据所有权。'); await owner.assertOwned(); };
  const checkpoint = async () => { await ownership(); await gateway.assertIdentity(); };
  const save = async (phase: Phase) => { requireThat(journal, 'JOURNAL_INVALID', '操作记录尚未建立。'); journal.phase = phase; await atomicWrite(journalPath, JSON.stringify(journal, null, 2), () => operationLease.assertOwned()); };
  const archive = async () => {
    await save('done'); await secureDir(path.join(dir, 'history'));
    await atomicWrite(path.join(dir, 'history', `${journal!.id}.json`), JSON.stringify(journal, null, 2), () => operationLease.assertOwned());
    await fs.unlink(journalPath); await syncDir(dir);
  };
  const releaseOwner = async () => { if (owner) { await owner.release(); owner = undefined; } };
  const takeOwner = async () => { await secureDir(target.authDir); owner = await gateway.acquireLock(await fs.realpath(target.authDir)); await checkpoint(); };
  const rollback = async () => {
    requireThat(journal, 'JOURNAL_INVALID', '缺少恢复记录。');
    await checkpoint();
    if (journal.hashes !== undefined && !['restored', 'prepared', 'stopping', 'locked'].includes(journal.phase)) {
      await save('restoring');
      await restoreAuth(target.authDir, path.join(dir, 'backups', journal.id), journal.hashes, checkpoint);
    }
    await save('restored'); await releaseOwner();
    if (journal.originalRunning) await gateway.start();
    await archive();
  };
  const handoff = async () => {
    await releaseOwner(); await save('handoff');
    await gateway.start();
    const deadline = Date.now() + (options.connectTimeoutMs ?? 30_000);
    for (;;) {
      const status = await gateway.status();
      if (status.running && status.connected) break;
      requireThat(Date.now() < deadline, 'HANDOFF_TIMEOUT', '配对已完成，但 OpenClaw 尚未连通 WhatsApp；凭据已保留，请使用 --recover。');
      await delay(1_000, undefined, { signal: options.signal });
    }
    await archive(); options.log('OpenClaw 接管完成。');
  };
  try {
    journal = await readJournal(dir, target);
    if (options.recover) {
      requireThat(journal, 'NO_PENDING_OPERATION', '该账号没有未完成的操作。');
      if (journal.phase === 'done') { await archive(); return; }
      if (['paired', 'handoff'].includes(journal.phase)) { await handoff(); return; }
      await gateway.stop(); await takeOwner(); await rollback(); options.log('已恢复本地凭据及原运行状态。'); return;
    }
    requireThat(!journal, 'RECOVERY_REQUIRED', '该账号有未完成的操作，请先使用 --recover。');
    requireThat(options.phone, 'PHONE_REQUIRED', '缺少手机号。');
    const existing = await authFiles(target.authDir);
    requireThat(!existing.length || options.relink, 'EXISTING_AUTH', '已有凭据；重新绑定必须显式使用 --relink。');
    const status = await gateway.status();
    journal = { version: 1, id: randomUUID(), account: target.account, profile: target.profile, authDir: target.authDir, stateDir: target.stateDir, configPath: target.configPath, phase: 'prepared', originalRunning: status.running, createdAt: new Date().toISOString() };
    await save('prepared'); await save('stopping');
    options.log('正在暂停目标 WhatsApp 账号。');
    await gateway.stop(); await takeOwner(); await save('locked');
    const lockedFiles = await authFiles(target.authDir);
    requireThat(!lockedFiles.length || options.relink, 'EXISTING_AUTH', '停止账号后检测到已有凭据；需要 --relink。');
    journal.hashes = await backupAuth(target.authDir, path.join(dir, 'backups', journal.id), checkpoint);
    await save('backup-ready');
    await clearAuth(target.authDir, checkpoint); await save('pairing');
    let lastIdentityCheck = 0; let identityCheck: Promise<void> | undefined;
    const pairGuard = async () => {
      await ownership();
      if (Date.now() - lastIdentityCheck > 1_000) {
        identityCheck ??= gateway.assertIdentity().then(() => { lastIdentityCheck = Date.now(); }).finally(() => { identityCheck = undefined; });
        await identityCheck;
      }
    };
    await pair({ authDir: target.authDir, phone: options.phone, deviceName: options.deviceName, signal: options.signal, assertOwned: pairGuard, showCode: options.showCode });
    // Pair has already proved registration, closed its sockets and drained all writes.
    // Persist that fact before checking Gateway again so a restart cannot roll it back.
    await ownership(); await save('paired'); options.log('配对完成，凭据已保存。');
    await checkpoint();
    await handoff();
  } catch (error) {
    unsafeCleanup = error instanceof HelperError && error.code === 'UNSAFE_CLEANUP';
    if (journal && owner && !unsafeCleanup && !['paired', 'handoff', 'done'].includes(journal.phase)) {
      try { await rollback(); options.log('配对未完成，已恢复本地凭据和原运行状态。'); }
      catch { throw new HelperError('RECOVERY_REQUIRED', '自动恢复未完成；已保留操作记录和备份，请使用 --recover。'); }
    }
    throw error;
  } finally {
    // If socket closure cannot be proven, retain the live-PID lock until CLI termination.
    if (!unsafeCleanup) await releaseOwner();
    await operationLease.release();
  }
}
