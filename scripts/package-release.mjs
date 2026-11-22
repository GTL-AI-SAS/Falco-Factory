import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipFiles } from '../lib/zip.mjs';
import { VERSION, WRANGLER_VERSION } from '../lib/args.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const excludes = new Set(['.git','node_modules','.generated','.wrangler','.falco-operations','dist','coverage','test-results']);
const includes = new Set(['.github','assets','bin','docs','examples','frontend-kit-template','lib','scripts','templates','tests','ui']);
const selected = new Map();
let packageLockCurrent = false;
try {
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  packageLockCurrent = lock.packages?.['']?.devDependencies?.wrangler === WRANGLER_VERSION
    && lock.packages?.['node_modules/wrangler']?.version === WRANGLER_VERSION
    && lock.packages?.['node_modules/miniflare']?.version === '5.20261119.0-beta'
    && lock.packages?.['node_modules/workerd']?.version === '1.20261119.1'
    && lock.packages?.['node_modules/undici']?.version === '7.30.2';
} catch { packageLockCurrent = false; }

async function addTree(directory = '') {
  const files = await fs.readdir(path.join(root, directory), { withFileTypes: true });
  for (const file of files.sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (excludes.has(file.name) || /^\.env|^\.dev\.vars|\.log$/.test(file.name)) continue;
    const relative = directory ? directory + '/' + file.name : file.name;
    if (file.isDirectory() && (directory || includes.has(file.name))) await addTree(relative);
    else if (file.isFile() && (directory || file.name === 'Falco Studio.exe' || /^(?:\.gitignore|package\.json|.*\.(?:md|txt|cmd))$/.test(file.name) || (file.name === 'package-lock.json' && packageLockCurrent))) {
      selected.set(relative, await fs.readFile(path.join(root, relative)));
    }
  }
}

await addTree();
const folder = path.resolve(process.argv[2] ?? path.join(root, 'dist'));
await fs.mkdir(folder, { recursive: true });
const output = path.join(folder, 'GTL_AI_Falco_Factory_v' + VERSION + '.zip');
await fs.writeFile(output, zipFiles(selected, { maxFiles: 500 }));
console.log(output);
