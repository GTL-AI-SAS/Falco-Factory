/**
 * Build a deterministic, read-only Client Action proposal check.
 * The website action handler is never invoked by this helper or by smoke().
 */
export function buildActionTest(actions, message) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('Cannot verify a Client Action: configure at least one action first.');
  }
  if (typeof message !== 'string' || message.trim().length < 3 || message.trim().length > 500 ||
      /[\u0000-\u001f\u007f]/.test(message)) {
    throw new Error('Enter a test message between 3 and 500 printable characters.');
  }
  const target = actions[0];
  if (!target || typeof target.id !== 'string' || !target.id) {
    throw new Error('The first configured Client Action has an invalid ID.');
  }
  const params = {};
  for (const [name, definition] of Object.entries(target.parameters ?? {})) {
    if (!Array.isArray(definition?.enum) || definition.enum.length === 0) {
      throw new Error(`Client Action parameter "${name}" has no allowed test value.`);
    }
    params[name] = definition.enum[0];
  }
  return { id: target.id, params, message: message.trim() };
}

export function verificationStatus(value, explicitStatus) {
  if (['pass','failed','skipped','not_configured','not_authorized','unsupported_provider','pending'].includes(explicitStatus)) return explicitStatus;
  if (value === true) return 'pass';
  if (value === false) return 'failed';
  return 'skipped';
}
