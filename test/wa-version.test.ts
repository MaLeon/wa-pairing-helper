import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWhatsAppWebVersion } from '../src/wa-version.js';

test('fetches and parses the live Baileys WhatsApp Web version through the supplied dispatcher', async () => {
  const dispatcher = {};
  let seenUrl = '';
  const version = await fetchWhatsAppWebVersion(async (url, init) => {
    seenUrl = url;
    assert.equal(init.dispatcher, dispatcher);
    assert.equal(init.method, 'GET');
    assert.ok(init.signal instanceof AbortSignal);
    return { ok: true, status: 200, async text() { return 'export const a = 1;\nconst version = [2, 3000, 1043857760] as const;\n'; } };
  }, dispatcher);
  assert.equal(seenUrl, 'https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/index.ts');
  assert.deepEqual(version, [2, 3000, 1043857760]);
});

test('refuses stale fallback when the live version endpoint fails', async () => {
  await assert.rejects(fetchWhatsAppWebVersion(async () => ({ ok: false, status: 503, async text() { return ''; } }), {}), { code: 'WA_VERSION_UNAVAILABLE' });
});
