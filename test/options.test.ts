import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions, normalizePhone } from '../src/options.js';
import { assertDefaultProfile } from '../src/openclaw.js';

test('account is explicit; default instance is distinct from default account', () => {
  assert.throws(() => parseOptions([]), /--account/);
  assert.throws(() => parseOptions(['--account', '']), /--account/);
  assert.throws(() => parseOptions(['--account', '../sales']));
  assert.equal(parseOptions(['--account', 'default'])?.profile, undefined);
  assert.equal(parseOptions(['--profile', 'company2', '--account', 'sales'])?.profile, 'company2');
});
test('invalid modes and inherited profile fail closed', () => {
  assert.throws(() => parseOptions(['--account', 'sales', '--check', '--relink']));
  assert.throws(() => parseOptions(['--account', 'sales', '--recover', '--phone', '12345678']));
  assert.throws(() => parseOptions(['--account', 'sales', '--device-name', 'AI Bot']));
  assert.throws(() => parseOptions(['--account', 'sales', '--device-name', 'AI Bot', '--relink', '--check']));
  assert.throws(() => parseOptions(['--account', 'sales', '--device-name', '   ', '--relink']));
  assert.throws(() => parseOptions(['--account', 'sales', '--device-name', 'A\nBot', '--relink']));
  assert.equal(parseOptions(['--account', 'sales', '--device-name', 'AI Bot', '--relink'])?.deviceName, 'AI Bot');
  assert.throws(() => assertDefaultProfile(parseOptions(['--account', 'sales'])!, { OPENCLAW_PROFILE: 'other' }));
  assert.doesNotThrow(() => assertDefaultProfile(parseOptions(['--account', 'sales', '--profile', 'work'])!, { OPENCLAW_PROFILE: 'other' }));
});
test('phone validation does not silently strip letters or guess a country', () => {
  assert.equal(normalizePhone('+60 (123) 456-789'), '60123456789');
  for (const invalid of ['abc60123456789', '0060123456789', '123', '+60 ext 12', '6012345678901234']) assert.throws(() => normalizePhone(invalid));
});
