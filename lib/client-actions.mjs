/** Falco Client Actions v1.1: small, declarative and explicitly unprivileged. */
export const MAX_ACTION_BYTES = 3900; // Cloudflare's per-var max is 5 KB; leave headroom.
const ID = /^[a-z][a-z0-9_.-]{2,48}$/;
const PARAM = /^[a-z][a-z0-9_]{0,30}$/;
const VALUE = /^[\p{L}\p{N}_. :/-]{1,60}$/u;
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
export function normalizeClientActions(raw = []) {
  let input = raw;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_ACTION_BYTES) throw Error('Client actions JSON exceeds 3.9 KB.');
    try { input = JSON.parse(input); } catch { throw Error('Client actions must be valid JSON.'); }
  }
  if (!Array.isArray(input) || input.length > 8) throw Error('Client actions must be an array with at most 8 entries.');
  const seen = new Set();
  const actions = input.map((action, index) => {
    if (!plain(action) || Object.keys(action).some(k => !['id','description','parameters'].includes(k))) throw Error(`Action ${index + 1}: unsupported fields.`);
    if (typeof action.id !== 'string' || !ID.test(action.id) || seen.has(action.id)) throw Error(`Action ${index + 1}: invalid or repeated id.`);
    seen.add(action.id);
    if (typeof action.description !== 'string' || action.description.length < 10 || action.description.length > 240 || /[\u0000-\u001f]/.test(action.description)) throw Error(`Action ${action.id}: description must be 10–240 printable characters.`);
    const parameters = action.parameters ?? {};
    if (!plain(parameters) || Object.keys(parameters).length > 3) throw Error(`Action ${action.id}: at most 3 parameters allowed.`);
    const normalizedParams = {};
    for (const [key, definition] of Object.entries(parameters)) {
      if (!PARAM.test(key) || !plain(definition) || Object.keys(definition).some(k => !['type','enum'].includes(k)) || definition.type !== 'string' || !Array.isArray(definition.enum) || definition.enum.length < 1 || definition.enum.length > 12 || new Set(definition.enum).size !== definition.enum.length || definition.enum.some(v => typeof v !== 'string' || !VALUE.test(v))) {
        throw Error(`Action ${action.id}: ${key} must have type:string and a closed enum of 1–12 safe values.`);
      }
      normalizedParams[key] = { type: 'string', enum: [...definition.enum] };
    }
    return { id: action.id, description: action.description, parameters: normalizedParams };
  });
  if (Buffer.byteLength(JSON.stringify(actions), 'utf8') > MAX_ACTION_BYTES) throw Error('Client actions manifest exceeds 3.9 KB.');
  return actions;
}
export const GALLINAS_ACTIONS = [{ id:'demo.open', description:'Abrir una de las tres opciones visuales del sitio Gallinas y Valientes cuando el visitante lo solicite.', parameters:{ option:{type:'string',enum:['01','02','03']} } }];
