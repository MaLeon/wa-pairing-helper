export class HelperError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'HelperError'; }
}
export function requireThat(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new HelperError(code, message);
}
// Provider/CLI errors can include secrets. Never print their original message or stack.
export function publicError(error: unknown): string {
  return error instanceof HelperError ? `[${error.code}] ${error.message}` : '[UNEXPECTED] 操作失败；原始错误已隐藏，以避免泄露认证内容。';
}
