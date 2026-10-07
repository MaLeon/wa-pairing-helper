import fs from 'node:fs/promises';
import path from 'node:path';
import { BufferJSON, initAuthCreds, proto, type AuthenticationState, type SignalDataTypeMap } from 'baileys';
import { atomicWrite, exists, isAuthFile, readRegular, syncDir } from './files.js';
import { HelperError, requireThat } from './errors.js';

export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private error: unknown;
  private sealed = false;
  constructor(private readonly onError: (error: unknown) => void) {}
  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.sealed) return Promise.reject(new HelperError('STORE_CLOSED', '认证存储已关闭。'));
    const result = this.tail.then(async () => { if (this.error) throw this.error; return task(); });
    this.tail = result.catch(e => { if (!this.error) { this.error = e; this.onError(e); } });
    return result;
  }
  async drain(): Promise<void> {
    for (;;) { const pending = this.tail; await pending; if (pending === this.tail) break; }
    if (this.error) throw this.error;
  }
  seal(): void { this.sealed = true; }
}
export async function createAuthState(dir: string, guard: () => Promise<void>, onError: (error: unknown) => void) {
  const queue = new WriteQueue(onError);
  const fileFor = (category: string, id: string) => {
    const name = `${category}-${id}.json`.replace(/\//g, '__').replace(/:/g, '-');
    requireThat(!name.includes('\\') && isAuthFile(name), 'AUTH_KEY_INVALID', 'Baileys 返回了不支持的认证文件类型。');
    return path.join(dir, name);
  };
  const read = async (file: string) => await exists(file) ? JSON.parse((await readRegular(file)).toString(), BufferJSON.reviver) : null;
  const creds = await read(path.join(dir, 'creds.json')) ?? initAuthCreds();
  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => queue.run(async () => {
        const result: Record<string, SignalDataTypeMap[T]> = {};
        for (const id of ids) {
          let data = await read(fileFor(type, id));
          if (data && type === 'app-state-sync-key') data = proto.Message.AppStateSyncKeyData.fromObject(data);
          result[id] = data;
        }
        return result;
      }),
      set: async data => {
        // Serialize now so later in-memory mutations cannot rewrite an earlier queued operation.
        const operations = Object.entries(data).flatMap(([category, entries]) => Object.entries(entries ?? {}).map(([id, value]) => ({ file: fileFor(category, id), bytes: value ? JSON.stringify(value, BufferJSON.replacer) : null })));
        await queue.run(async () => {
          for (const op of operations) {
            await guard();
            if (op.bytes !== null) await atomicWrite(op.file, op.bytes, guard);
            else if (await exists(op.file)) { await readRegular(op.file); await fs.unlink(op.file); await syncDir(dir); }
          }
        });
      },
    },
  };
  return {
    state, queue,
    saveCreds() {
      const bytes = JSON.stringify(state.creds, BufferJSON.replacer);
      return queue.run(() => atomicWrite(path.join(dir, 'creds.json'), bytes, guard));
    },
  };
}
