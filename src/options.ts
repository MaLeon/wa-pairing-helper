import { parseArgs } from 'node:util';
import { requireThat } from './errors.js';
export interface Options { account: string; profile?: string; phone?: string; deviceName?: string; binary?: string; check: boolean; relink: boolean; recover: boolean; }
export const HELP = `openclaw-wa-pair --account <id> [选项]

  --profile <name>       指定实例；省略选择默认实例
  --openclaw-bin <path>  指定 OpenClaw 可执行文件，否则从 PATH 查找
  --phone <number>       含国家码的手机号；省略则交互输入
  --check               只读预检，不请求关联码、不暂停账号
  --relink              备份原凭据并重新绑定
  --recover             恢复该账号未完成的操作
  --device-name <name>   重新绑定时设置实验性设备显示名称（需 --relink）
  --help                帮助

仅支持 Linux 本机、同一系统用户及已配置启用的账号。
仅适配 OpenClaw 2026.7.1-2、官方 WhatsApp 2026.7.1 与 Baileys 7.0.0-rc13。
通过 Gateway 账号级 stop/start 完成交接；不支持其他进程同时操作目标凭据目录。
Ubuntu 24.04 默认账号已完成真机配对与接管；其他验收项见项目文档。
`;
export function parseOptions(args: string[]): Options | null {
  const { values: v } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    account: { type: 'string' }, profile: { type: 'string' }, phone: { type: 'string' },
    'device-name': { type: 'string' }, 'openclaw-bin': { type: 'string' },
    check: { type: 'boolean' }, relink: { type: 'boolean' }, recover: { type: 'boolean' }, help: { type: 'boolean' },
  }});
  if (v.help) return null;
  requireThat(typeof v.account === 'string' && v.account.trim(), 'ACCOUNT_REQUIRED', '--account 必须显式填写。');
  requireThat(/^[a-z0-9][a-z0-9_-]*$/.test(v.account), 'ACCOUNT_INVALID', '账号须使用规范的小写字母、数字、下划线或连字符。');
  if (v.profile !== undefined) requireThat(/^[a-zA-Z0-9_-]+$/.test(v.profile), 'PROFILE_INVALID', 'profile 名称无效。');
  requireThat([v.check, v.relink, v.recover].filter(Boolean).length <= 1, 'MODE_CONFLICT', '--check、--relink、--recover 不能同时使用。');
  requireThat(!(v.recover && (v.phone || v['device-name'])), 'MODE_CONFLICT', '--recover 不接受手机号或设备名称。');
  requireThat(!(v['device-name'] && (!v.relink || v.check)), 'MODE_CONFLICT', '--device-name 仅能与 --relink 一起用于实际重新绑定。');
  if (v['device-name'] !== undefined) {
    const name = v['device-name'].trim();
    requireThat(name.length > 0 && [...name].length <= 32 && !/[\u0000-\u001f\u007f-\u009f]/u.test(name), 'DEVICE_NAME_INVALID', '设备名称须为 1–32 个字符，且不能包含控制字符。');
  }
  if (v['openclaw-bin'] !== undefined) requireThat(v['openclaw-bin'].trim(), 'BINARY_INVALID', '可执行文件路径不能为空。');
  return { account: v.account, profile: v.profile, phone: v.phone, deviceName: v['device-name'], binary: v['openclaw-bin'], check: !!v.check, relink: !!v.relink, recover: !!v.recover };
}
export function normalizePhone(value: string): string {
  requireThat(/^\+?[0-9 ()-]+$/.test(value.trim()), 'PHONE_INVALID', '手机号只能包含数字及常见分隔符。');
  const digits = value.replace(/[+ ()-]/g, '');
  requireThat(/^[1-9][0-9]{6,14}$/.test(digits), 'PHONE_INVALID', '请填写含国家码的完整手机号（7–15 位数字）。');
  return digits;
}
