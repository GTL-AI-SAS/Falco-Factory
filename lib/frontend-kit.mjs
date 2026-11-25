/** Export a fully public, design-neutral frontend ZIP. No Worker code or secrets. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipFiles } from './zip.mjs';
import { normalizeOrigins } from './origins.mjs';
import { normalizeClientActions } from './client-actions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_DIR = path.join(ROOT, 'frontend-kit-template');
const FILES = [
  'core/falco-client.js', 'actions/action-controller.js', 'actions/action-contract.js', 'integration/reservation-actions.example.js', 'actions/actions.manifest.js', 'integration/gallinas-actions.example.js', 'ACTION_INTEGRATION_GUIDE.md',
  'widget/falco-widget.html', 'widget/falco-widget.css', 'widget/falco-widget.js',
  'config/falco.config.js', 'demo/index.html', 'demo/server.mjs',
  'ABRIR_FALCO_KIT.cmd',
  'integration/ABRIR_DEMO.cmd', 'integration/tools/falco-static-server.mjs',
  'README.md', 'LEER_PRIMERO_AGENTE.md', 'AGENT_GUIDE.md', 'API_CONTRACT.md', 'PRIVACY_TEMPLATE.md', 'QA_CHECKLIST.md',
];
const VALID_NAME = /^falco-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateKitInfo({ name, endpoint, allowedOrigins, actions = [] }) {
  if (typeof name !== 'string' || name.length > 63 || !VALID_NAME.test(name)) throw new Error('Only a valid Falco Worker may be exported.');
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Unable to determine the Worker HTTPS endpoint.'); }
  if (url.protocol !== 'https:' || !url.hostname || !url.pathname.endsWith('/chat') ||
      url.username || url.password || url.search || url.hash) throw new Error('Frontend endpoint must be a public HTTPS /chat URL.');
  return { name, endpoint: url.href, allowedOrigins: normalizeOrigins(allowedOrigins), actions: normalizeClientActions(actions) };
}

function privacySettings(input) {
  const url = input?.url ?? '';
  const notice = input?.notice ?? '';
  if (typeof notice !== 'string' || notice.length > 400 || /[\u0000-\u0008\u000b-\u001f]/.test(notice)) throw new Error('Privacy notice must be plain text up to 400 characters.');
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Privacy policy URL must be public HTTPS.');
  }
  return { url, notice };
}

export async function createFrontendKit(info, { templateDir = TEMPLATE_DIR } = {}) {
  const meta = validateKitInfo(info);
  const config = {
    endpoint: meta.endpoint,
    assistantName: 'Assistant',
    launcherLabel: 'Chat',
    welcomeMessage: 'Hello! How can I help you?',
    placeholder: 'Write a message',
    timeoutMs: 16000,
    maxHistory: 8,
    privacy: privacySettings(info.privacy),
  };
  const entries = new Map();
  for (const file of FILES) {
    let content = await fs.readFile(path.join(templateDir, file), 'utf8');
    if (file === 'actions/actions.manifest.js') content = content.replace('__FALCO_ACTIONS__', JSON.stringify(meta.actions, null, 2));
    if (file === 'config/falco.config.js') content = content.replace('__FALCO_CONFIG__', JSON.stringify(config, null, 2));
    if (file === 'README.md') {
      content = content.replaceAll('__WORKER_NAME__', meta.name)
        .replaceAll('__CHAT_ENDPOINT__', meta.endpoint)
        .replaceAll('__ALLOWED_ORIGINS__', meta.allowedOrigins.map(x => '- `'+x+'`').join('\n'));
    }
    // Linux checkouts use LF; Windows launchers must always export as CRLF.
    if (file.endsWith('.cmd')) content = content.replace(/\r\n|\r|\n/g, '\r\n');
    entries.set(file, content);
  }
  entries.set('ACTIONS_MANIFEST.json', JSON.stringify({ worker: meta.name, endpoint: meta.endpoint, actions: meta.actions, verifiedFrom: 'Cloudflare deployed Worker bindings at export time', exportedAt: new Date().toISOString() }, null, 2) + '\n');
  entries.set('ALLOWED_ORIGINS.json', JSON.stringify({
    worker: meta.name, endpoint: meta.endpoint, origins: meta.allowedOrigins,
    verifiedFrom: 'Cloudflare deployed Worker bindings at export time', exportedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  entries.set('ALLOWED_ORIGINS.md', `# Allowed website origins — ${meta.name}\n\nVerified from Cloudflare's deployed Worker settings when this ZIP was exported.\n\n${meta.allowedOrigins.map(x => '- \`' + x + '\`').join('\n')}\n\nThese are exact **scheme + host + port** origins, not complete page URLs.\n\n- For GitHub Pages, a project path is not part of Origin (e.g. https://gtl-ai-sas.github.io).\n- For Cloudflare Pages, use the actual https://...pages.dev origin.\n- Local file:// sends Origin: null and is deliberately NOT allowed.\n- The allowlist may change after this ZIP is exported. Re-export to obtain the latest verified list.\n- CORS does not authenticate API callers: preserve Cloudflare rate limiting.\n`);
  const filename = `${meta.name}-frontend-kit.zip`;
  return { filename, bytes: zipFiles(entries), files: [...entries.keys()], endpoint: meta.endpoint };
}
