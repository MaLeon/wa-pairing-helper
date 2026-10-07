import type { UserFacingSocketConfig } from 'baileys';
export interface Target {
  binary: string; coreRoot: string; pluginRoot: string; profile: string; account: string;
  stateDir: string; configPath: string; authDir: string; gatewayUrl: string;
  coreVersion: string; pluginVersion: string; baileysVersion: string;
}
export interface AccountStatus { running: boolean; connected: boolean; }
export interface Lease { assertOwned(): Promise<void>; release(): Promise<void>; }
export interface Gateway {
  target: Target;
  socketOptions?: Partial<UserFacingSocketConfig>;
  resolveWhatsAppVersion(): Promise<[number, number, number]>;
  status(): Promise<AccountStatus>;
  assertIdentity(): Promise<void>;
  stop(): Promise<void>;
  start(): Promise<void>;
  acquireLock(resource: string): Promise<Lease>;
}
export type Pair = (args: { authDir: string; phone: string; deviceName?: string; signal: AbortSignal; assertOwned: () => Promise<void>; showCode: (code: string) => void }) => Promise<void>;
