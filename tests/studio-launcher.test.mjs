import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execute = promisify(execFile);
test('native launcher runs the CMD in the background, captures diagnostics and resolves a moved folder', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'falco hidden launcher '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const executable = path.join(root, 'Falco Studio.exe');
  await execute(compiler, ['/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll', '/out:' + executable,
    '/win32icon:' + path.resolve('ui/assets/falco-studio.ico'), path.resolve('scripts/studio-launcher.cs')], { windowsHide: true });
  await assert.rejects(execute(executable, ['--launcher-check'], { windowsHide: true }), error => error.code === 1);
  await fs.writeFile(path.join(root, 'package.json'), '{}');
  await fs.writeFile(path.join(root, 'main.cmd'), '@echo off\r\n>launched.txt echo %FALCO_STUDIO_BACKGROUND%\r\necho stub output\r\necho stub error 1>&2\r\nexit /b 0\r\n');
  await execute(executable, ['--launcher-check'], { windowsHide: true });
  await execute(executable, [], { windowsHide: true });
  assert.equal((await fs.readFile(path.join(root, 'launched.txt'), 'utf8')).trim(), '1');
  const log = await fs.readFile(path.join(root, '.falco-operations/studio-launcher.log'), 'utf8');
  assert.match(log, /stub output/);
  assert.match(log, /stub error/);
  await fs.rename(path.join(root, 'main.cmd'), path.join(root, 'ABRIR_FALCO_STUDIO.cmd'));
  await execute(executable, ['--launcher-check'], { windowsHide: true });
  await execute(executable, [], { windowsHide: true });
});
