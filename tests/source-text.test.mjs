import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { normalizeSource, sameSource, sourceFingerprint } from '../lib/source-text.mjs';
import { runtimeFiles, sha256 } from '../lib/runtime-manifest.mjs';
import { normalizeConfig } from '../lib/args.mjs';
import { generate } from '../lib/generate.mjs';
import { readProject } from '../lib/projects.mjs';
import { GALLINAS_ACTIONS } from '../lib/client-actions.mjs';
import { prepareActionUpgrade } from '../lib/action-updates.mjs';
import { planRuntimeUpgrade, applyRuntimeUpgrade } from '../lib/runtime-upgrades.mjs';
import { planProviderSharedRepair, applyProviderSharedRepair } from '../lib/provider-runtime-compat.mjs';
import { planKvMigration } from '../lib/kv-migration.mjs';
import { prepareCorsUpgrade, applyOriginChanges } from '../lib/origin-updates.mjs';

const crlf = text => normalizeSource(text).replace(/\n/g, '\r\n');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-source-eol-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = normalizeConfig({ name: 'falco-source-eol', business: 'Line ending test', origin: 'https://example.com', 'account-id': 'a'.repeat(32) }, root);
  await generate(config);
  return readProject(root, config.name);
}

test('source fingerprints ignore CRLF only while manifest hashes remain byte-exact', () => {
  const lf = 'export const answer = 42;\n';
  assert.equal(sourceFingerprint(lf), sourceFingerprint(crlf(lf)));
  assert.equal(sameSource(lf, crlf(lf)), true);
  assert.notEqual(sha256(lf), sha256(crlf(lf)));
  for (const modified of [lf.replace('42', '43'), lf + '// custom change\n', lf.replace(' = ', '=')]) {
    assert.equal(sameSource(lf, modified), false);
    assert.notEqual(sourceFingerprint(lf), sourceFingerprint(modified));
  }
});

test('current CRLF runtimes are recognized for action, runtime and KV updates; real modifications stay blocked', async t => {
  const project = await fixture(t);
  for (const file of runtimeFiles) {
    const target = path.join(project.output, file);
    await fs.writeFile(target, crlf(await fs.readFile(target, 'utf8')));
  }
  assert.equal((await prepareActionUpgrade(project, GALLINAS_ACTIONS)).upgrade, false);
  assert.equal((await planRuntimeUpgrade(project)).needed, false);
  assert.equal((await planKvMigration(project)).needsRuntime, false);
  await fs.appendFile(path.join(project.output, 'src/index.mjs'), '\r\n// customized handler\r\n');
  await assert.rejects(prepareActionUpgrade(project, GALLINAS_ACTIONS), /customized\/unknown/);
  await assert.rejects(planRuntimeUpgrade(project), /Customized or unknown/);
  await assert.rejects(planKvMigration(project), /Unknown or customized/);
});

test('legacy CRLF action and provider sources are recognized and provider backups preserve original bytes', async t => {
  const project = await fixture(t);
  const legacyIndex = crlf(await fs.readFile('tests/fixtures/v1.0-worker-index.mjs.txt', 'utf8'));
  await fs.writeFile(path.join(project.output, 'src/index.mjs'), legacyIndex);
  const actionPlan = await prepareActionUpgrade(project, GALLINAS_ACTIONS);
  assert.equal(actionPlan.upgrade, true);
  assert.equal(actionPlan.oldSource, legacyIndex);
  // The planned action runtime imports helpers absent from the legacy shared module.
  const legacyShared = crlf(await fs.readFile('tests/fixtures/v1.1/src/providers/shared.mjs', 'utf8'));
  const target = path.join(project.output, 'src/providers/shared.mjs');
  await fs.writeFile(target, legacyShared);
  const plan = await planProviderSharedRepair(project, { plannedSources: { 'src/index.mjs': actionPlan.newSource } });
  assert.equal(plan.needed, true);
  const repaired = await applyProviderSharedRepair(project, plan, randomUUID());
  assert.equal(await fs.readFile(repaired.backupFile, 'utf8'), legacyShared);
  const manifest = JSON.parse(await fs.readFile(path.join(project.output, '.falco-runtime.json'), 'utf8'));
  assert.equal(manifest.files[plan.file], sha256(await fs.readFile(target)));
  await fs.writeFile(target, legacyShared + '// custom change\r\n');
  await assert.rejects(planProviderSharedRepair(project), /customized or not a recognized/);
});

test('legacy CRLF runtime upgrades preserve backup bytes and reject changes made after preflight', async t => {
  const project = await fixture(t);
  const files = ['src/index.mjs', 'src/client-actions.mjs', 'src/providers/shared.mjs', 'src/providers/gemini.mjs', 'src/providers/openai.mjs'];
  for (const file of files) await fs.writeFile(path.join(project.output, file), crlf(await fs.readFile(path.join('tests/fixtures/v1.1', file), 'utf8')));
  const plan = await planRuntimeUpgrade(project);
  assert.equal(plan.needed, true);
  await fs.mkdir(path.join(project.output, '.falco-history'), { recursive: true });
  const result = await applyRuntimeUpgrade(project, plan, randomUUID());
  for (const file of files) {
    const original = crlf(await fs.readFile(path.join('tests/fixtures/v1.1', file), 'utf8'));
    assert.equal(await fs.readFile(path.join(result.backupDir, file), 'utf8'), original);
  }
  assert.equal((await planRuntimeUpgrade(project)).needed, false);
  const target = path.join(project.output, 'src/index.mjs');
  await fs.writeFile(target, crlf(await fs.readFile('tests/fixtures/v1.1/src/index.mjs', 'utf8')));
  const stalePlan = await planRuntimeUpgrade(project);
  await fs.appendFile(target, '\r\n// changed during preflight\r\n');
  await assert.rejects(applyRuntimeUpgrade(project, stalePlan, randomUUID()), /Source changed during preflight/);
});

test('CORS patch recognizes CRLF snippets while retaining the original source backup', async t => {
  const project = await fixture(t);
  const target = path.join(project.output, 'src/index.mjs');
  const source = crlf("// Preserve other source.\nfunction cors(env, origin) {\n    const allowed = env.ALLOWED_ORIGIN;\n    const cors = origin && origin === allowed ? corsHeaders(origin) : { Vary: 'Origin' };\n    if (origin && origin !== allowed) return error('origin_not_allowed', 403, cors);\n    return cors;\n}\n");
  await fs.writeFile(target, source);
  const plan = await prepareCorsUpgrade(project);
  assert.equal(plan.changed, true);
  assert.equal(plan.previous, source);
  assert.match(plan.upgraded, /Preserve other source/);
  assert.match(plan.upgraded, /env\.ALLOWED_ORIGINS/);
  const id = randomUUID();
  await fs.mkdir(path.join(project.output, '.falco-history'), { recursive: true });
  await applyOriginChanges(project, ['https://example.com'], plan, id);
  assert.equal(await fs.readFile(path.join(project.output, '.falco-history', id + '.src-index.mjs'), 'utf8'), source);
});
