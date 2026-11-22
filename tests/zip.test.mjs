import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { zipFiles } from '../lib/zip.mjs';

test('release ZIP preserves the Studio launcher name with spaces and its binary content', () => {
  const name = 'Falco Studio.exe';
  const content = Buffer.from([0x4d, 0x5a, 0, 255]);
  const zip = zipFiles(new Map([[name, content]]));
  const nameSize = zip.readUInt16LE(26);
  const compressedSize = zip.readUInt32LE(18);
  assert.equal(zip.subarray(30, 30 + nameSize).toString('utf8'), name);
  assert.deepEqual(inflateRawSync(zip.subarray(30 + nameSize, 30 + nameSize + compressedSize)), content);
});

test('ZIP filenames still reject traversal and Windows path aliases', () => {
  for (const name of ['../launcher.exe', '/launcher.exe', 'C:/launcher.exe', 'folder\\launcher.exe',
    'folder//launcher.exe', 'folder /launcher.exe', 'folder./launcher.exe', 'launcher.exe ', 'launcher.exe.', ' leading.exe']) {
    assert.throws(() => zipFiles(new Map([[name, 'data']])), /Unsafe ZIP filename/, name);
  }
});
