/** Shared public contract for Factory, Worker, and browser. No network or executable configuration. */
export const MAX_ACTION_BYTES = 3900;
const ID = /^[a-z][a-z0-9_.-]{2,48}$/;
const KEY = /^[a-z][a-zA-Z0-9_]{0,30}$/;
const ENUM_VALUE = /^[\p{L}\p{N}_. :/-]{1,60}$/u;
const forbidden = key => ['__proto__','constructor','prototype'].includes(key);
export const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const printable = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const fieldsOnly = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key) && !forbidden(key));
function invalid(message) { throw new Error('Invalid client action: ' + message); }

export function normalizeActions(raw = []) {
  if (typeof raw === 'string') {
    if (new TextEncoder().encode(raw).byteLength > MAX_ACTION_BYTES) invalid('manifest exceeds 3.9 KB.');
    try { raw = JSON.parse(raw); } catch { invalid('manifest must be valid JSON.'); }
  }
  if (!Array.isArray(raw) || raw.length > 8) invalid('use an array with at most 8 entries.');
  const ids = new Set();
  const actions = raw.map(action => {
    if (!fieldsOnly(action, ['id','description','parameters','requiresConfirmation','resultFields'])) invalid('unsupported fields.');
    if (typeof action.id !== 'string' || !ID.test(action.id) || ids.has(action.id)) invalid('invalid or repeated id.');
    ids.add(action.id);
    if (!printable(action.description, 240) || action.description.length < 10) invalid('description must be 10–240 printable characters.');
    const parameters = action.parameters ?? {};
    if (!plain(parameters) || Object.keys(parameters).length > 8) invalid('use at most 8 parameters.');
    const normalized = {};
    for (const [name, spec] of Object.entries(parameters)) {
      if (!KEY.test(name) || forbidden(name) || !fieldsOnly(spec,['type','enum','minLength','maxLength','minimum','maximum','required','description'])) invalid('invalid parameter definition.');
      if (spec.required !== undefined && typeof spec.required !== 'boolean') invalid('required must be boolean.');
      if (spec.description !== undefined && !printable(spec.description,160)) invalid('parameter description must be public text under 160 characters.');
      const result = { type: spec.type };
      if (spec.enum !== undefined) {
        if (spec.type !== 'string' || !Array.isArray(spec.enum) || spec.enum.length < 1 || spec.enum.length > 12 ||
          new Set(spec.enum).size !== spec.enum.length || spec.enum.some(v => typeof v !== 'string' || !ENUM_VALUE.test(v)) ||
          ['minLength','maxLength','minimum','maximum'].some(k => spec[k] !== undefined)) invalid('use a closed enum of 1–12 string values.');
        result.enum = [...spec.enum];
      } else if (spec.type === 'string') {
        if (!Number.isInteger(spec.maxLength) || spec.maxLength < 1 || spec.maxLength > 500 ||
          (spec.minLength !== undefined && (!Number.isInteger(spec.minLength) || spec.minLength < 1 || spec.minLength > spec.maxLength)) ||
          spec.minimum !== undefined || spec.maximum !== undefined) invalid('text needs maxLength 1–500, or a closed enum.');
        if (spec.minLength !== undefined) result.minLength = spec.minLength;
        result.maxLength = spec.maxLength;
      } else if (['number','integer'].includes(spec.type)) {
        if (!Number.isFinite(spec.minimum) || !Number.isFinite(spec.maximum) || spec.minimum > spec.maximum || Math.abs(spec.minimum) > 1e9 || Math.abs(spec.maximum) > 1e9 ||
          spec.minLength !== undefined || spec.maxLength !== undefined || (spec.type === 'integer' && (!Number.isInteger(spec.minimum) || !Number.isInteger(spec.maximum)))) invalid('numbers need finite minimum/maximum within ±1 billion.');
        result.minimum = spec.minimum; result.maximum = spec.maximum;
      } else if (!['date','boolean'].includes(spec.type) || ['minLength','maxLength','minimum','maximum'].some(k => spec[k] !== undefined)) invalid('supported types: string, date, number, integer, boolean.');
      if (spec.required !== undefined) result.required = spec.required;
      if (spec.description !== undefined) result.description = spec.description;
      normalized[name] = result;
    }
    const result = { id:action.id, description:action.description, parameters:normalized };
    if (action.requiresConfirmation !== undefined && typeof action.requiresConfirmation !== 'boolean') invalid('requiresConfirmation must be boolean.');
    if (action.requiresConfirmation !== undefined) result.requiresConfirmation = action.requiresConfirmation;
    else if (Object.values(normalized).some(p => !p.enum) || action.resultFields !== undefined) result.requiresConfirmation = true;
    if (action.resultFields !== undefined) {
      if (!Array.isArray(action.resultFields) || action.resultFields.length > 8 || new Set(action.resultFields).size !== action.resultFields.length ||
        action.resultFields.some(key => typeof key !== 'string' || !KEY.test(key) || forbidden(key) || /token|secret|password|authorization|cookie/i.test(key))) invalid('resultFields must list up to 8 public field names, without credential fields.');
      result.resultFields = [...action.resultFields];
    }
    return result;
  });
  if (bytes(actions) > MAX_ACTION_BYTES) invalid('manifest exceeds 3.9 KB.');
  return actions;
}
export function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}
export function validValue(value, spec) {
  if (spec.enum) return typeof value === 'string' && spec.enum.includes(value);
  if (spec.type === 'string') return printable(value,spec.maxLength) && value.trim() === value && value.length >= (spec.minLength ?? 1);
  if (spec.type === 'date') return isDate(value);
  if (spec.type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'number' && Number.isFinite(value) && value >= spec.minimum && value <= spec.maximum && (spec.type !== 'integer' || Number.isInteger(value));
}
export function validateAction(request, actions) {
  if (!fieldsOnly(request,['id','params']) || Object.keys(request).length !== 2 || typeof request.id !== 'string' || !plain(request.params)) return null;
  const spec = actions.find(a => a.id === request.id);
  if (!spec || Object.keys(request.params).some(key => !Object.hasOwn(spec.parameters,key) || forbidden(key))) return null;
  for (const [key, definition] of Object.entries(spec.parameters)) {
    if (!Object.hasOwn(request.params,key)) { if (definition.required !== false) return null; }
    else if (!validValue(request.params[key],definition)) return null;
  }
  const result = { id:spec.id, params:Object.fromEntries(Object.keys(spec.parameters).filter(k => Object.hasOwn(request.params,k)).map(k => [k,request.params[k]])) };
  return bytes(result) <= 2048 ? result : null;
}
export const interactiveAction = spec => spec.requiresConfirmation !== undefined || spec.resultFields !== undefined || Object.values(spec.parameters).some(p => !p.enum);
export const requestIdValid = id => typeof id === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id);
const scalar = value => value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || printable(value,500);
export function publicResult(value, spec, status = 'success') {
  const result = { status };
  if (printable(value?.message,500)) result.message = value.message;
  if (bytes(result) > 1600) delete result.message;
  if (typeof value?.code === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value.code)) result.code = value.code;
  const data = {};
  if (plain(value?.data)) for (const key of spec.resultFields || []) if (Object.hasOwn(value.data,key) && scalar(value.data[key]) &&
    bytes({...result,data:{...data,[key]:value.data[key]}}) <= 1600) data[key] = value.data[key];
  if (Object.keys(data).length) result.data = data;
  return result;
}
export function validateActionResult(raw, actions) {
  if (!fieldsOnly(raw,['requestId','action','status','data','message','code']) || !requestIdValid(raw.requestId) ||
    !['success','error','cancelled','unknown'].includes(raw.status)) return null;
  const action = validateAction(raw.action,actions);
  if (!action) return null;
  const spec = actions.find(a => a.id === action.id);
  if (!interactiveAction(spec)) return null;
  const clean = publicResult(raw,spec,raw.status);
  if (raw.data !== undefined && (!plain(raw.data) || Object.keys(raw.data).length !== Object.keys(clean.data || {}).length ||
    Object.keys(raw.data).some(k => !Object.hasOwn(clean.data || {},k) || raw.data[k] !== clean.data[k]))) return null;
  if (raw.message !== undefined && clean.message !== raw.message || raw.code !== undefined && clean.code !== raw.code) return null;
  const result = { requestId:raw.requestId, action, ...clean };
  return bytes(result) <= 4096 ? result : null;
}
/** Read-only sample values for Studio simulation and proposal checks. */
export function sampleParameters(action) {
  return Object.fromEntries(Object.entries(action.parameters).filter(([,s]) => s.required !== false).map(([key,s]) => [key,
    s.enum ? s.enum[0] : s.type === 'date' ? '2027-01-15' : s.type === 'boolean' ? true : ['number','integer'].includes(s.type) ? s.minimum : 'x'.repeat(s.minLength ?? 1)]));
}
