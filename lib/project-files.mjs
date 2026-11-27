import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function optionalStat(file) {
  return fs.lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

export async function atomicWrite(file, data) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, data, { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export function atomicJson(file, object) {
  return atomicWrite(file, JSON.stringify(object, null, 2) + '\n');
}

export async function withProjectLock(output, work, { testLab = false } = {}) {
  if (!testLab && path.basename(path.dirname(output)) === '.generated') {
    const home = path.join(path.dirname(path.dirname(output)), '.falco-test-lab');
    const stat = await optionalStat(home);
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe Test Lab state requires manual review before modifying projects.');
      const emergencyStat = await optionalStat(path.join(home, 'emergencies.json'));
      if (emergencyStat) {
        if (!emergencyStat.isFile() || emergencyStat.isSymbolicLink()) throw new Error('Unsafe Test Lab emergency record.');
        const emergencies = JSON.parse(await fs.readFile(path.join(home,'emergencies.json'),'utf8'));
        if (!Array.isArray(emergencies) || emergencies.length) throw new Error('Test Lab emergency review blocks project mutations.');
      }
      const sessions = path.join(home,'sessions'), sessionsStat = await optionalStat(sessions);
      if (sessionsStat && (!sessionsStat.isDirectory() || sessionsStat.isSymbolicLink())) throw new Error('Unsafe Test Lab sessions directory.');
      if (sessionsStat && (await fs.readdir(sessions)).length) throw new Error('An active Test Lab or unfinished cleanup blocks project mutations.');
    }
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  const lock = output + '.falco-lock';
  let handle;
  try {
    handle = await fs.open(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('This project is locked. If the previous Factory process stopped, check its outcome and remove the sibling .falco-lock file before retrying.');
  }
  try {
    await handle.writeFile(String(process.pid));
    return await work();
  } finally {
    await handle.close();
    await fs.unlink(lock);
  }
}

export async function applyProjectFiles(output, files, { reason, snapshot } = {}) {
  const backupId = snapshot?.id ?? randomUUID();
  const backup = path.join(output, '.falco-history', backupId + '.' + reason);
  const before = new Map();
  for (const file of files.keys()) {
    const target = path.join(output, file);
    for (let dir = path.dirname(target); dir !== path.dirname(output); dir = path.dirname(dir)) {
      const stat = await optionalStat(dir);
      if (stat && !stat.isDirectory()) throw new Error('Project contains a non-directory path. Operation refused.');
    }
    const stat = await optionalStat(target);
    if (stat && !stat.isFile()) throw new Error('Project contains a non-regular file. Operation refused.');
    before.set(file, stat ? await fs.readFile(target) : null);
  }
  const history = path.dirname(backup);
  await fs.mkdir(history, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(history)).isDirectory()) throw new Error('Invalid project history directory.');
  await fs.mkdir(backup, { mode: 0o700 });
  for (const [file, data] of before) {
    if (data === null) continue;
    const target = path.join(backup, file);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, data, { flag: 'wx', mode: 0o600 });
  }
  const manifest = path.join(backup, 'transaction.json');
  await atomicJson(manifest, { status: 'pending', files: [...before.keys()], created: [...before].filter(([, data]) => data === null).map(([file]) => file) });
  const applied = [];
  try {
    for (const [file, data] of files) {
      const target = path.join(output, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicWrite(target, data);
      applied.push(file);
    }
    await atomicJson(manifest, { status: 'committed', files: [...before.keys()] });
  } catch (error) {
    try {
      for (const file of applied.reverse()) {
        const target = path.join(output, file);
        const original = before.get(file);
        if (original === null) await fs.rm(target, { force: true });
        else await atomicWrite(target, original);
      }
      await atomicJson(manifest, { status: 'reverted' });
    } catch {
      throw new Error('Local write interrupted. Restore the original files from ' + backup + ' before continuing.');
    }
    throw error;
  }
  return backupId;
}

export async function assertNoPendingTransaction(output) {
  const history = path.join(output, '.falco-history');
  const files = await fs.readdir(history, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of files) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}\.before-regenerate$/.test(entry.name)) continue;
    const record = await fs.readFile(path.join(history, entry.name, 'transaction.json'), 'utf8').then(JSON.parse, error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (record?.status === 'pending') throw new Error('An interrupted regeneration requires local recovery. Use falco recover with backup ' + entry.name.split('.')[0] + '.');
  }
}

export async function recoverRegeneration(output, id) {
  if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('Provide the exact regeneration backup ID.');
  return withProjectLock(output, async () => {
    const dir = path.join(output, '.falco-history', id + '.before-regenerate');
    const manifest = path.join(dir, 'transaction.json');
    const record = JSON.parse(await fs.readFile(manifest, 'utf8'));
    if (record.status !== 'pending') throw new Error('Only interrupted regeneration transactions can be repaired from this command.');
    if (!Array.isArray(record.files) || !Array.isArray(record.created) || record.files.some(file =>
      typeof file !== 'string' || !/^[a-z0-9./-]+$/i.test(file) || file.startsWith('/') || file.includes('..'))) {
      throw new Error('Invalid recovery manifest.');
    }
    for (const file of record.files) {
      const target = path.join(output, file);
      if (record.created.includes(file)) await fs.rm(target, { force: true });
      else await atomicWrite(target, await fs.readFile(path.join(dir, file)));
    }
    await atomicJson(manifest, { status: 'reverted' });
  });
}
