#!/usr/bin/env node
// Experimental, explicit developer operation. Never patches OpenClaw's dependencies.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HASH = 'dccf8a85eb698c5ebe7d7e2a0639949bcd8ed37cbc3584ec0ea5d709852ab7c6';
const before = 'os: config.browser[0],';
const after = 'os: config.helperDeviceName ?? config.browser[0],';
export function patchSource(source) {
  if (source.includes(after)) return source;
  if (createHash('sha256').update(source).digest('hex') !== HASH || source.split(before).length !== 2) throw new Error('Unexpected Baileys artifact; no patch applied.');
  return source.replace(before, after);
}
async function main() {
  if (!['--check', '--apply'].includes(process.argv[2]) || process.argv.length !== 3) throw new Error('Usage: node scripts/device-name-patch.mjs --check|--apply');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const req = createRequire(path.join(root, 'package.json'));
  const entry = await realpath(req.resolve('baileys'));
  const ownModules = (await realpath(path.join(root, 'node_modules'))) + path.sep;
  if (!entry.startsWith(ownModules)) throw new Error('Refusing to patch an external dependency tree.');
  const target = path.join(path.dirname(entry), 'Utils', 'validate-connection.js');
  const source = await readFile(target, 'utf8'); const patched = patchSource(source);
  if (process.argv[2] === '--apply' && source !== patched) await writeFile(target, patched);
  console.log(process.argv[2] === '--apply' ? 'Helper-only experimental patch applied. CLI --device-name remains disabled pending real-device acceptance.' : 'Helper-only patch applicable. No files changed.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
