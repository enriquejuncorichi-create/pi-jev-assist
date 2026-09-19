import test from 'node:test';
import assert from 'node:assert/strict';
import { shortlistInactive, toolsToActivate } from '../src/tools-router.js';

const tools = [
  { name: 'browser', description: 'control a web browser' },
  { name: 'browser_click', description: 'click a page element' },
  { name: 'gh', description: 'GitHub CLI' },
  { name: 'read', description: 'read a file' },
];

test('shortlist is lexical and only inactive tools', () => {
  const got = shortlistInactive('open the github pr in the browser', tools, new Set(['read']));
  assert.ok(got.some(t => t.name === 'browser'));
  assert.ok(!got.some(t => t.name === 'read'));
});

test('activation is a threshold on noul, not a planner step', () => {
  assert.deepEqual(
    toolsToActivate(tools, { browser: { noul: 0.8 }, gh: { noul: 0.2 } }, 0.65),
    ['browser'],
  );
});
