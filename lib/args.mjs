import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeOrigins } from './origins.mjs';

export const VERSION = '0.8.0';
export const DEFAULT_MODELS = Object.freeze({ mock: 'mock-v1', openai: 'gpt-5.4-mini', gemini: 'gemini-3.5-flash-lite' });
const VALUE_FLAGS = new Set(['name','business','provider','model','origin','origins','faq','instructions','output','account-id','mock-reply','rate-limit','rate-namespace']);
const BOOLEAN_FLAGS = new Set(['deploy','dry-run','force','help']);
export function parseArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const [key, inline] = a.slice(2).split('=', 2);
    if (BOOLEAN_FLAGS.has(key)) {
      if (inline !== undefined) throw new Error(`--${key} does not take a value`);
      values[key] = true;
    } else if (VALUE_FLAGS.has(key)) {
      const value = inline ?? args[++i];
      if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`);
      if (key in values) throw new Error(`Duplicate flag --${key}`);
      values[key] = value;
    } else throw new Error(`Unknown option: --${key}`);
  }
  return values;
}
export function normalizeConfig(opts, cwd = process.cwd()) {
  if (!opts.name || !/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(opts.name)) {
    throw new Error('--name must be 3-63 lowercase letters, digits, hyphens; start with a letter and end alphanumeric');
  }
  if (!opts.business || opts.business.trim().length < 2 || opts.business.length > 100) throw new Error('--business must be between 2 and 100 characters');
  const provider = opts.provider ?? 'mock';
  if (!Object.hasOwn(DEFAULT_MODELS, provider)) throw new Error('--provider must be mock, openai or gemini');
  const model = opts.model ?? DEFAULT_MODELS[provider];
  if (!/^[\w.:-]{2,100}$/.test(model)) throw new Error('Invalid --model identifier');
  if (opts.origin !== undefined && opts.origins !== undefined) throw new Error('Use either --origin or --origins, not both.');
  const origins = normalizeOrigins(opts.origins ?? opts.origin ?? 'http://localhost:3000');
  const origin = origins[0]; // Retained for backward compatibility with v0.1-v0.6 projects.
  const output = path.resolve(cwd, opts.output ?? path.join('.generated', opts.name));
  const faq = opts.faq ? readText(opts.faq, cwd, 24000, '--faq') : '';
  const instructions = opts.instructions ? readText(opts.instructions, cwd, 12000, '--instructions') : '';
  const rateLimit = opts['rate-limit'] ? Number(opts['rate-limit']) : 10;
  if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 1000) throw new Error('--rate-limit must be an integer from 1 to 1000 requests/min/IP/PoP');
  const namespaceId = opts['rate-namespace'] ?? String(createHash('sha256').update(`falco:${opts.name}`).digest().readUInt32BE(0) + 1000);
  if (!/^[1-9]\d{0,13}$/.test(namespaceId)) throw new Error('--rate-namespace must be a positive integer string');
  const mockReply = opts['mock-reply'] ?? `¡Hola! Soy Falco, el asistente de ${opts.business.trim()}. ¿En qué puedo ayudarte?`;
  if (mockReply.length > 400) throw new Error('--mock-reply is too long');
  const accountId = opts['account-id'] ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? null;
  if (accountId && !/^[0-9a-f]{32}$/i.test(accountId)) throw new Error('--account-id / CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal ID');
  if (opts['dry-run'] && opts.deploy) throw new Error('--dry-run and --deploy are mutually exclusive');
  return { name: opts.name, business: opts.business.trim(), provider, model, origin, origins, output, faq,
    instructions, mockReply, rateLimit, namespaceId, accountId, deploy: Boolean(opts.deploy),
    dryRun: Boolean(opts['dry-run']), force: Boolean(opts.force) };
}
function readText(file, cwd, maxBytes, flag) {
  const data = readFileSync(path.resolve(cwd, file));
  if (data.byteLength > maxBytes) throw new Error(`${flag} exceeds ${maxBytes} bytes; shorten the document`);
  return data.toString('utf8');
}
