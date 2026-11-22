import { businessInstructions, faqText } from './business-context.mjs';

export const ACTIVE_KNOWLEDGE_KEY = 'knowledge:active';
const MAX_FAQ_BYTES = 96000;
const MAX_INSTRUCTIONS_BYTES = 24000;
const utf8 = value => new TextEncoder().encode(value).byteLength;

export class KnowledgeUnavailableError extends Error {
  constructor() { super('knowledge_unavailable'); this.name = 'KnowledgeUnavailableError'; }
}

/** Only active KV, never client-supplied knowledge or public frontend content. */
export async function loadBusinessKnowledge(env) {
  const mode = env.KNOWLEDGE_MODE || 'embedded';
  if (mode === 'embedded') return { instructions: businessInstructions, faq: faqText };
  if (mode !== 'kv' || !env.FALCO_KNOWLEDGE?.get) throw new KnowledgeUnavailableError();
  let data;
  try { data = await env.FALCO_KNOWLEDGE.get(ACTIVE_KNOWLEDGE_KEY, 'json'); }
  catch { throw new KnowledgeUnavailableError(); }
  if (!data || data.version !== 1 || typeof data.instructions !== 'string' || typeof data.faq !== 'string' ||
    utf8(data.instructions) > MAX_INSTRUCTIONS_BYTES || utf8(data.faq) > MAX_FAQ_BYTES) throw new KnowledgeUnavailableError();
  if (data.revision !== undefined && !/^[a-f0-9]{64}$/.test(data.revision)) throw new KnowledgeUnavailableError();
  return { instructions: data.instructions, faq: data.faq, ...(data.revision ? { revision: data.revision } : {}) };
}

export async function verifiedRevision(knowledge) {
  if (!knowledge.revision) return null;
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, instructions: knowledge.instructions, faq: knowledge.faq }));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const revision = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
  if (revision !== knowledge.revision) throw new KnowledgeUnavailableError();
  return revision;
}
