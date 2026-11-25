/** Deterministic local allowlist. Model output never selects a URL or executable. */
import { normalizeActions, validateAction, interactiveAction, publicResult, requestIdValid, plain } from './action-contract.js';
export function createActionController(manifest, handlers = {}) {
  const actions = normalizeActions(manifest);
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers) || Object.getPrototypeOf(handlers) !== Object.prototype) throw Error('Action handlers must be a map of local functions.');
  const allowed = new Map(actions.map(a => [a.id,a]));
  const invocations = new Map();
  return Object.freeze({
    async dispatch(request, { requestId, confirmed = false, signal, timeoutMs = 30000 } = {}) {
      const valid = validateAction(request,actions);
      if (!valid) return { executed:false,reason:'not_allowed' };
      const spec = allowed.get(valid.id), modern = interactiveAction(spec);
      if (modern && !requestIdValid(requestId)) return {executed:false,reason:'request_id_required'};
      if (modern && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)) throw Error('Action timeout must be 1?120000 ms.');
      if (spec.requiresConfirmation && confirmed !== true) return {executed:false,reason:'confirmation_required'};
      const payload = JSON.stringify(valid);
      const previous = modern ? invocations.get(requestId) : null;
      if (previous) return previous.payload === payload ? previous.promise : {executed:false,reason:'request_id_reused'};
      if (modern && invocations.size >= 100) return {executed:false,reason:'session_action_limit'};
      const finish = (status, value, reason) => ({ executed:status === 'success', ...(reason ? {reason} : {}),
        ...(modern ? { result:{requestId,action:valid,...publicResult(value,spec,status)} } : {}) });
      const execute = async () => {
        if (signal?.aborted) return finish('cancelled',{},'cancelled');
        const handler = Object.hasOwn(handlers,valid.id) ? handlers[valid.id] : null;
        if (typeof handler !== 'function') return finish('error',{code:'handler_missing'},'handler_missing');
        const control = new AbortController();
        let timer, abort;
        try {
          const stopped = new Promise(resolve => {
            abort = () => {control.abort();resolve(finish('unknown',{code:'execution_interrupted'},'execution_interrupted'));};
            signal?.addEventListener('abort',abort,{once:true});
            if (signal?.aborted) abort();
            timer = setTimeout(abort,timeoutMs);
          });
          const work = Promise.resolve().then(() => {
            if (control.signal.aborted) return finish('cancelled',{},'cancelled');
            return handler({...valid.params},{requestId,idempotencyKey:requestId,signal:control.signal});
          }).then(value => {
            if (modern && value !== false && !plain(value)) return finish('unknown',{},'handler_unconfirmed');
            if (value === false || value?.ok === false) return finish('error',value,'handler_rejected');
            if (modern && value?.ok !== true) return finish('unknown',{},'handler_unconfirmed');
            return finish('success',value);
          }).catch(() => finish(modern ? 'unknown' : 'error',{},'handler_failed'));
          return await Promise.race([work,stopped]);
        } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
      };
      const promise = execute();
      if (modern) invocations.set(requestId,{payload,promise});
      return promise;
    },
    get ids() {return [...allowed.keys()];},
    definition(id) {const spec=allowed.get(id);return spec ? structuredClone(spec) : null;}
  });
}
