/** Browser-side, deterministic allowlist. Never eval model output. */
const idRule = /^[a-z][a-z0-9_.-]{2,48}$/;
const own = obj => Boolean(obj && typeof obj === 'object' && !Array.isArray(obj) && Object.getPrototypeOf(obj) === Object.prototype);
export function createActionController(manifest, handlers = {}) {
  if (!Array.isArray(manifest) || manifest.length > 8) throw Error('Invalid Falco action manifest.');
  const allowed = new Map();
  for(const a of manifest) {
    if (!own(a) || !idRule.test(a.id) || allowed.has(a.id) || !own(a.parameters)) throw Error('Invalid action in manifest.');
    allowed.set(a.id, a);
  }
  if (!own(handlers)) throw Error('Action handlers must be a map of local functions.');
  return Object.freeze({
    async dispatch(request) {
      if (!own(request) || Object.keys(request).sort().join(',') !== 'id,params' || typeof request.id !== 'string') return {executed:false,reason:'invalid_action'};
      const def = allowed.get(request.id);
      if (!def || !own(request.params) || Object.keys(request.params).sort().join(',') !== Object.keys(def.parameters).sort().join(',')) return {executed:false,reason:'not_allowed'};
      for (const [key, spec] of Object.entries(def.parameters)) {
        if (spec?.type !== 'string' || !Array.isArray(spec.enum) || typeof request.params[key] !== 'string' || !spec.enum.includes(request.params[key])) return {executed:false,reason:'invalid_parameters'};
      }
      // A model can request a manifest action but cannot register handlers or choose a function dynamically.
      const handler = Object.hasOwn(handlers, request.id) ? handlers[request.id] : null;
      if (typeof handler !== 'function') return {executed:false,reason:'handler_missing'};
      try {
        const result = await handler({ ...request.params });
        return result === false || result?.ok === false ? {executed:false,reason:'handler_rejected'} : {executed:true};
      } catch { return {executed:false,reason:'handler_failed'}; }
    },
    get ids() { return [...allowed.keys()]; }
  });
}
