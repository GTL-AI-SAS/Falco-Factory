import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './runtime-manifest.mjs';
import { sourceFingerprint, normalizeSource } from './source-text.mjs';
import { planPreviewRuntime } from './runtime-upgrades.mjs';

const MOVENS_GUARD = '764e1092141f4b4bccf6e9f29df3a3cf752703669967e193105368eab268d211';
// Read source as data only. Never import/evaluate the selected project's code in Studio.
export async function snapshotTestSource(project, regularPath) {
  const snapshot = new Map(), checksums = {};
  let size = 0;
  async function visit(dir) {
    await regularPath(project.output,dir,true);
    for (const item of await fs.readdir(path.join(project.output,dir),{withFileTypes:true})) {
      const file = dir + '/' + item.name;
      if (item.isSymbolicLink()) throw Error('Test Lab source symlinks are refused.');
      if (item.isDirectory()) {await visit(file);continue;}
      if (!/\.(mjs|js|json)$/.test(item.name)) continue;
      await regularPath(project.output,file);
      const stat = await fs.stat(path.join(project.output,file));
      size += stat.size;
      if (size > 2000000 || snapshot.size >= 100) throw Error('Test Lab source exceeds the bounded snapshot limit.');
      const source = await fs.readFile(path.join(project.output,file),'utf8');
      checksums[file] = sha256(source);
      snapshot.set(file,source);
    }
  }
  await visit('src');
  return {snapshot,checksums};
}

export async function preparePreviewModules(snapshot, main) {
  const input = new Map(snapshot);
  let gatewayProfile;
  const index = normalizeSource(input.get('src/index.mjs') ?? '');
  const suffix = index.match(/\nexport default withMovensAuth\(movensFalcoWorker, '(admin|clients|employees)'\);\s*$/);
  const prefix = "import { withMovensAuth } from './movens-auth.mjs';\n";
  if (suffix && index.startsWith(prefix) && sourceFingerprint(input.get('src/movens-auth.mjs') ?? '') === MOVENS_GUARD) {
    gatewayProfile = suffix[1];
    input.set('src/index.mjs',index.slice(prefix.length).replace('const movensFalcoWorker = {','export default {').replace(suffix[0],''));
  }
  const sources = await planPreviewRuntime(input);
  if (gatewayProfile) sources.set('src/index.mjs',prefix + sources.get('src/index.mjs').replace('export default {','const movensFalcoWorker = {') + `\nexport default withMovensAuth(movensFalcoWorker, '${gatewayProfile}');\n`);
  const core = sources.get('src/index.mjs') ?? '';
  if (!core.includes('actionRequestId') || !core.includes('actionResult')) {
    throw Error('The copied runtime needs a Test Lab adapter for Client Action protocol 2. Its custom code was preserved; production upgrades are not required.');
  }
  const required = new Map();
  function include(file) {
    if (required.has(file) || file === 'src/business-context.mjs') return;
    const code = sources.get(file);
    if (code === undefined) throw Error('Missing local Preview dependency: ' + file);
    required.set(file,code);
    if (file.endsWith('.json')) return;
    if (/\bimport\s*\(|\brequire\s*\(/.test(code)) throw Error('Dynamic or CommonJS dependencies need an isolated Test Lab adapter: ' + file);
    const imports = [...code.matchAll(/\b(?:from\s*|import\s*)(['"])([^'"\r\n]+)\1/g)];
    for (const [, , specifier] of imports) {
      if (specifier === 'cloudflare:workers') continue;
      if (!specifier.startsWith('.')) throw Error('Unsupported Preview package or external module: ' + specifier);
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier));
      if (!dependency.startsWith('src/') || !/\.(mjs|js|json)$/.test(dependency)) throw Error('Preview imports must stay within local src modules.');
      include(dependency);
    }
  }
  include(main);
  return {sources:required,gatewayProfile};
}
