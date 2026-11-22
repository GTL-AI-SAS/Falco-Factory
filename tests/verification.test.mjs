import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActionTest, verificationStatus } from '../lib/verification.mjs';

test('builds a read-only test case from the first configured action and first enum values', () => {
  const actions = [
    { id:'demo.open', parameters:{ option:{type:'string',enum:['01','02','03']}, style:{type:'string',enum:['full','compact']} } },
    { id:'demo.other', parameters:{} }
  ];
  assert.deepEqual(buildActionTest(actions, 'Please open option 01.'), {
    id:'demo.open', params:{option:'01',style:'full'}, message:'Please open option 01.'
  });
});

test('action verification requires configured actions and a bounded printable message', () => {
  assert.throws(() => buildActionTest([], 'Please do it.'), /configure at least one action/);
  const actions = [{ id:'demo.open', parameters:{} }];
  assert.throws(() => buildActionTest(actions, ''), /3 and 500/);
  assert.throws(() => buildActionTest(actions, 'x'.repeat(501)), /3 and 500/);
  assert.throws(() => buildActionTest(actions, 'abc\nxyz'), /printable/);
});

test('verification status prefers explicit lifecycle state over legacy booleans', () => {
  assert.equal(verificationStatus(null, 'not_authorized'), 'not_authorized');
  assert.equal(verificationStatus(null), 'skipped');
  assert.equal(verificationStatus(true), 'pass');
  assert.equal(verificationStatus(false), 'failed');
});
