import { HelperError, requireThat } from './errors.js';

export type VersionFetch = (url: string, init: { method: 'GET'; dispatcher: unknown; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
const VERSION_URL = 'https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/index.ts';

export async function fetchWhatsAppWebVersion(fetcher: VersionFetch, dispatcher: unknown): Promise<[number, number, number]> {
  try {
    const response = await fetcher(VERSION_URL, { method: 'GET', dispatcher, signal: AbortSignal.timeout(15_000) });
    requireThat(response.ok, 'WA_VERSION_UNAVAILABLE', `无法从 Baileys 官方源获取当前 WhatsApp Web 协议版本（HTTP ${response.status}）；未连接或写入凭据。`);
    const line = (await response.text()).split('\n').find(value => /^\s*const version = \[/.test(value));
    const match = line?.match(/const version = \[(\d+),\s*(\d+),\s*(\d+)\]/);
    requireThat(match, 'WA_VERSION_UNAVAILABLE', 'Baileys 官方源未返回可识别的 WhatsApp Web 协议版本；未连接或写入凭据。');
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  } catch (error) {
    if (error instanceof HelperError) throw error;
    throw new HelperError('WA_VERSION_UNAVAILABLE', '获取当前 WhatsApp Web 协议版本失败；未连接或写入凭据。');
  }
}
