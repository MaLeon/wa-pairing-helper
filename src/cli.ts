#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parseOptions, normalizePhone, HELP } from './options.js';
import { HelperError, publicError, requireThat } from './errors.js';
import { connectOpenClaw } from './openclaw.js';
import { enableDeviceNamePatch } from './device-name.js';
import { runWorkflow, operationDir, readJournal } from './workflow.js';
import { authFiles } from './files.js';

async function main(): Promise<void> {
  process.umask(0o077);
  const [major, minor] = process.versions.node.split('.').map(Number);
  requireThat(major === 24 && minor! >= 16, 'NODE_VERSION', '请使用 Node.js 24.16 或更新的 24.x 版本。');
  let options;
  try { options = parseOptions(process.argv.slice(2)); } catch (error) { if (error instanceof HelperError) throw error; throw new HelperError('ARGUMENTS', '命令参数无效，请查看 --help。'); }
  if (!options) { stdout.write(HELP); return; }
  if (options.deviceName) await enableDeviceNamePatch();
  const gateway = await connectOpenClaw(options);
  const t = gateway.target;
  stdout.write(`wa-pairing-helper 0.1.0\nOpenClaw: ${t.binary}\n版本: ${t.coreVersion} / WhatsApp ${t.pluginVersion} / Baileys ${t.baileysVersion}\nProfile: ${t.profile}\n账号: ${t.account}\n配置: ${t.configPath}\nGateway: ${t.gatewayUrl}\n凭据目录: ${t.authDir}\n兼容状态: 2026.7.1-2 固定基线，尚未完成真机验收\n`);
  if (options.deviceName) stdout.write(`设备显示名称（实验性）: ${options.deviceName}\n`);
  const files = await authFiles(t.authDir); const pending = await readJournal(operationDir(t), t);
  if (options.check) { stdout.write(`凭据文件: ${files.length}\n待恢复操作: ${pending ? '有' : '无'}\n只读预检完成。\n`); return; }
  requireThat(options.recover || !pending, 'RECOVERY_REQUIRED', '存在未完成操作，请使用 --recover。');
  requireThat(options.recover || options.relink || !files.length, 'EXISTING_AUTH', '已有凭据；请使用 --relink。');
  let phone = options.phone;
  if (!options.recover) {
    requireThat(stdout.isTTY, 'TTY_REQUIRED', '关联码仅允许显示在交互终端，请使用 SSH 终端运行。');
    if (phone === undefined) {
      requireThat(stdin.isTTY, 'PHONE_REQUIRED', '非交互环境必须填写 --phone。');
      const rl = createInterface({ input: stdin, output: stdout });
      try { phone = await rl.question('WhatsApp 手机号（含国家码）：'); } finally { rl.close(); }
    }
    phone = normalizePhone(phone);
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const { createPair } = await import('./pairing.js');
    await runWorkflow(gateway, createPair({ resolveVersion: async () => gateway.resolveWhatsAppVersion() }, gateway.socketOptions), { relink: options.relink, recover: options.recover, phone, signal: abort.signal,
      deviceName: options.deviceName,
      showCode(code) { stdout.write(`\n关联码：${code}\n请在手机 WhatsApp → 已关联设备 → 关联设备 → 改用电话号码关联 中输入。\n`); },
      log(message) { stdout.write(`${message}\n`); },
    });
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
// Exit also kills any socket whose cleanup could not be proved; its lock stays on disk for recovery.
main().catch(error => { process.stderr.write(`${publicError(error)}\n`); process.exit(1); });
