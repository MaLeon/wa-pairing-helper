import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { requireThat } from './errors.js';

const categories = ['app-state-sync-key', 'app-state-sync-version', 'device-list', 'identity-key', 'lid-mapping', 'pre-key', 'sender-key', 'sender-key-memory', 'session', 'tctoken'];
export function isAuthFile(name: string): boolean {
  return name === 'creds.json' || name === 'creds.json.bak' ||
    (name.endsWith('.json') && categories.some(c => name.startsWith(`${c}-`)) && !name.includes('/') && !name.includes('\\'));
}
export async function exists(p: string): Promise<boolean> {
  try { await fs.lstat(p); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
// Reject symlink components; resolve the OS home path before calling this on macOS fixtures.
export async function assertSafePath(p: string): Promise<void> {
  const resolved = path.resolve(p); let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!await exists(current)) return;
    const st = await fs.lstat(current);
    requireThat(!st.isSymbolicLink(), 'UNSAFE_PATH', '目标路径包含符号链接，拒绝访问。');
    if (current !== resolved) requireThat(st.isDirectory(), 'UNSAFE_PATH', '目标父路径不是目录。');
  }
}
export async function secureDir(p: string): Promise<void> {
  await assertSafePath(p);
  await fs.mkdir(p, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(p);
  requireThat(st.isDirectory() && st.uid === process.getuid?.(), 'DIRECTORY_OWNER', '目录必须属于当前系统用户。');
  await fs.chmod(p, 0o700);
}
export async function readRegular(p: string): Promise<Buffer> {
  await assertSafePath(p);
  const file = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await file.stat();
    requireThat(st.isFile() && st.nlink === 1 && st.uid === process.getuid?.(), 'UNSAFE_FILE', '文件类型或所有权不安全。');
    return await file.readFile();
  } finally { await file.close(); }
}
export async function syncDir(dir: string): Promise<void> {
  const fd = await fs.open(dir, constants.O_RDONLY); try { await fd.sync(); } finally { await fd.close(); }
}
export async function atomicWrite(p: string, data: string | Buffer, guard: () => Promise<void> = async () => {}): Promise<void> {
  await guard(); await assertSafePath(p);
  if (await exists(p)) await readRegular(p);
  const temp = path.join(path.dirname(p), `.wa-pair-${randomUUID()}.tmp`);
  const fd = await fs.open(temp, 'wx', 0o600);
  try { await fd.writeFile(data); await fd.sync(); } finally { await fd.close(); }
  try { await guard(); await fs.rename(temp, p); await syncDir(path.dirname(p)); }
  finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
export async function authFiles(dir: string): Promise<string[]> {
  await assertSafePath(dir);
  if (!await exists(dir)) return [];
  const st = await fs.lstat(dir);
  requireThat(st.isDirectory() && st.uid === process.getuid?.(), 'DIRECTORY_OWNER', '凭据目录必须属于当前系统用户。');
  const files = await fs.readdir(dir);
  for (const name of files) {
    requireThat(isAuthFile(name) || /^\.wa-pair-[a-f0-9-]+\.tmp$/.test(name), 'UNKNOWN_AUTH_CONTENT', '凭据目录含无法识别的文件，拒绝覆盖。');
    await readRegular(path.join(dir, name));
  }
  return files.sort();
}
export function targetKey(authDir: string): string { return createHash('sha256').update(authDir).digest('hex'); }
export async function backupAuth(authDir: string, backupDir: string, guard: () => Promise<void>): Promise<Record<string, string>> {
  await secureDir(backupDir); const hashes: Record<string, string> = {};
  for (const name of await authFiles(authDir)) {
    // Incomplete atomic temp files are not credentials and are not promoted on restore.
    if (!isAuthFile(name)) continue;
    const bytes = await readRegular(path.join(authDir, name));
    await atomicWrite(path.join(backupDir, name), bytes, guard);
    hashes[name] = createHash('sha256').update(bytes).digest('hex');
  }
  await syncDir(backupDir); return hashes;
}
export async function clearAuth(authDir: string, guard: () => Promise<void>): Promise<void> {
  const files = await authFiles(authDir);
  for (const name of files) { await guard(); await fs.unlink(path.join(authDir, name)); }
  await syncDir(authDir);
}
export async function restoreAuth(authDir: string, backupDir: string, hashes: Record<string, string>, guard: () => Promise<void>): Promise<void> {
  const copies = new Map<string, Buffer>();
  for (const [name, hash] of Object.entries(hashes)) {
    requireThat(isAuthFile(name), 'BACKUP_INVALID', '备份记录含无效文件名。');
    const bytes = await readRegular(path.join(backupDir, name));
    requireThat(createHash('sha256').update(bytes).digest('hex') === hash, 'BACKUP_INVALID', '备份校验失败；保留当前文件等待人工处理。');
    copies.set(name, bytes);
  }
  await clearAuth(authDir, guard);
  for (const [name, bytes] of copies) await atomicWrite(path.join(authDir, name), bytes, guard);
}
