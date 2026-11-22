import { createHash } from 'node:crypto';

// Source recognition ignores only CRLF conversion. Keep raw source for backups,
// transaction preflight checks, and byte-level runtime manifests.
export const normalizeSource = text => text.replace(/\r\n/g, '\n');
export const sameSource = (left, right) => normalizeSource(left) === normalizeSource(right);
export const sourceFingerprint = text => createHash('sha256').update(normalizeSource(text)).digest('hex');
