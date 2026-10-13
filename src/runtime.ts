export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return (major === 24 && (minor > 16 || (minor === 16 && patch >= 0))) || (major === 26 && (minor > 1 || (minor === 1 && patch >= 0))) || major > 26;
}
