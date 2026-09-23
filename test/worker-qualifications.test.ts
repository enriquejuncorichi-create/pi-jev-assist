import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticEvidence, syntheticProfile } from './worker-evidence.test.js';
import { mkdtempSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importQualification, loadQualifications, saveQualifications, parseTrustedQualification } from '../src/worker-qualifications.js';

// Synthetic parser fixtures only: never imported into the user's trust store.
const evidence = syntheticEvidence();
const profile = () => syntheticProfile(evidence);
function bundle() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jev-qualification-test-')));
  const file = join(dir, 'profile.json');
  writeFileSync(join(dir, 'evidence.txt'), evidence);
  writeFileSync(file, JSON.stringify(profile()));
  return { dir, file };
}
test('strict profile schema rejects malformed, stale, unknown version and missing overhead evidence', () => {
  assert.equal(parseTrustedQualification(profile()).roles[0], 'scout');
  for (const value of [null, [], {}, { ...profile(), extra: true }, { ...profile(), roles: ['scout', 'implement'] }, { ...profile(), benchmarkVersion: 'unknown' }, { ...profile(), expiresAt: 1 }, { ...profile(), medianAcceptedMs: NaN }, { ...profile(), baselineMedianAcceptedMs: Infinity }, { ...profile(), reviewIncluded: false }, { ...profile(), repairIncluded: false }, { ...profile(), acceptedSamples: 0 }, { ...profile(), suiteHash: 'no' }, { ...profile(), route: { model: 'fast' } }]) assert.throws(() => parseTrustedQualification(value));
});
test('local bundle hash is checked on import and every reload; importing alone never persists trust', () => {
  const { dir, file } = bundle();
  const store = join(dir, 'trusted.json');
  const imported = importQualification(file);
  assert.equal(loadQualifications(store).length, 0);
  saveQualifications([imported], store);
  assert.equal(loadQualifications(store).length, 1);
  writeFileSync(join(dir, 'evidence.txt'), 'changed');
  assert.equal(loadQualifications(store).length, 0);
  assert.throws(() => importQualification(file), /hash/);
});
test('evidence traversal, absolute references and foreign network paths are rejected', () => {
  const { dir, file } = bundle();
  for (const evidenceRef of ['../evidence.txt', '..\\evidence.txt', join(dir, 'evidence.txt'), '//server/share/file', '\\\\server\\share\\file', 'C:relative']) {
    writeFileSync(file, JSON.stringify({ ...profile(), evidenceRef }));
    assert.throws(() => importQualification(file));
  }
  assert.throws(() => importQualification('//server/share/file'));
});
test('symlink or junction evidence traversal is rejected on the host filesystem', () => {
  const { dir, file } = bundle();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'jev-evidence-target-')));
  writeFileSync(join(outside, 'evidence.txt'), evidence);
  symlinkSync(outside, join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(file, JSON.stringify({ ...profile(), evidenceRef: 'linked/evidence.txt' }));
  assert.throws(() => importQualification(file), /Symlink/);
});
