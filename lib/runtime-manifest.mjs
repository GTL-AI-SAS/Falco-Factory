import { createHash } from 'node:crypto';

export const RUNTIME_VERSION = '1.8.0';
export const runtimeFiles = [
  'src/index.mjs', 'src/entry.mjs', 'src/budget-object.mjs', 'src/operations.mjs', 'src/knowledge-store.mjs', 'src/client-actions.mjs', 'src/action-contract.mjs',
  'src/providers/index.mjs', 'src/providers/mock.mjs', 'src/providers/openai.mjs',
  'src/providers/gemini.mjs', 'src/providers/shared.mjs'
];

export const sha256 = data => createHash('sha256').update(data).digest('hex');

export function runtimeManifest(files) {
  return { schema: 1, version: RUNTIME_VERSION, files: Object.fromEntries([...files].map(([name, data]) => [name, sha256(data)])) };
}
