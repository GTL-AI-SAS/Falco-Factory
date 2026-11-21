/** Origin allowlist validation shared by CLI, Studio and exports. */
export function validateOrigin(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 250) throw new Error('Each allowed origin must be a URL containing only scheme, host and optional port.');
  let u;
  try { u = new URL(value); } catch { throw new Error(`Invalid allowed origin: ${value}`); }
  if (value.includes('*') || !['http:', 'https:'].includes(u.protocol) || u.origin === 'null' || u.username || u.password ||
      u.pathname !== '/' || u.search || u.hash || u.origin !== value) throw new Error(`Invalid allowed origin (no path, wildcard or trailing slash): ${value}`);
  if (u.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(u.hostname)) throw new Error(`Public origins must use HTTPS: ${value}`);
  return value;
}
export function normalizeOrigins(input) {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\n,]/) : null;
  if (!raw || !raw.length || raw.some(x => typeof x !== 'string')) throw new Error('Provide at least one allowed origin.');
  const origins = raw.map(s => s.trim()).filter(Boolean);
  if (!origins.length || origins.length > 20) throw new Error('Use between 1 and 20 allowed origins.');
  const unique = [...new Set(origins.map(validateOrigin))];
  if (unique.length !== origins.length) throw new Error('Duplicate allowed origins are not permitted.');
  if (Buffer.byteLength(JSON.stringify(unique), 'utf8') > 4000) throw new Error('Allowed origins exceed 4 KB.');
  return unique;
}
/** Read ONLY non-secret public Cloudflare bindings. Fail if the remote values cannot be verified. */
export function readCloudflareOriginsBindings(settings) {
  const bindings = settings?.bindings;
  if (!Array.isArray(bindings)) throw new Error('Cloudflare did not return Worker bindings; cannot verify allowed origins for export.');
  const find = name => bindings.find(b => b?.name === name && b?.type === 'plain_text');
  const multi = find('ALLOWED_ORIGINS');
  if (multi) {
    let parsed;
    try { parsed = JSON.parse(multi.text ?? multi.value); } catch { throw new Error('Cloudflare ALLOWED_ORIGINS is invalid JSON; export refused.'); }
    return normalizeOrigins(parsed);
  }
  const legacy = find('ALLOWED_ORIGIN');
  if (legacy) return normalizeOrigins([legacy.text ?? legacy.value]);
  throw new Error('No allowed-origin binding was found in the deployed Worker. Export refused to avoid inaccurate CORS information.');
}
