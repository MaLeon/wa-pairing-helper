import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HelperError } from './errors.js';

const SOURCE_HASH = 'dccf8a85eb698c5ebe7d7e2a0639949bcd8ed37cbc3584ec0ea5d709852ab7c6';
const BEFORE = 'os: config.browser[0],';
const AFTER = 'os: config.helperDeviceName ?? config.browser[0],';

export function patchBaileysSource(source: string): string {
  if (source.includes(AFTER)) return source;
  if (createHash('sha256').update(source).digest('hex') !== SOURCE_HASH || source.split(BEFORE).length !== 2) {
    throw new HelperError('DEVICE_NAME_PATCH_UNSUPPORTED', 'Helper 自带 Baileys 文件与已验证补丁不匹配；未修改任何文件。');
  }
  return source.replace(BEFORE, AFTER);
}

/** Applies the exact, pinned experimental patch only when the user explicitly asks for a device name. */
export async function enableDeviceNamePatch(): Promise<void> {
  try {
    const require = createRequire(import.meta.url);
    const entry = await realpath(require.resolve('baileys'));
    const helperRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const ownModules = `${await realpath(path.join(helperRoot, 'node_modules'))}${path.sep}`;
    if (!entry.startsWith(ownModules)) throw new Error('Baileys is outside Helper dependencies');
    const target = path.join(path.dirname(entry), 'Utils', 'validate-connection.js');
    const source = await readFile(target, 'utf8');
    const patched = patchBaileysSource(source);
    if (patched !== source) await writeFile(target, patched);
  } catch (error) {
    if (error instanceof HelperError) throw error;
    throw new HelperError('DEVICE_NAME_PATCH_UNAVAILABLE', '无法安全启用设备名称补丁；未开始配对或修改凭据。');
  }
}
