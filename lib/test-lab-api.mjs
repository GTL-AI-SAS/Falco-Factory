import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { atomicWrite } from './project-files.mjs';
import { TEST_ACTIONS, TEST_RECORDS } from './test-lab-templates.mjs';
import { validateAction, requestIdValid, plain } from '../templates/worker/src/action-contract.mjs';

export const MAX_API_RECORDS = 200;
export function redactLab(value, secrets = []) {
  if (typeof value === 'string') {
    let clean = value.replace(/Bearer\s+[^\s"]+/gi, '[REDACTED]').replace(/(?:sk-|AIza)[a-zA-Z0-9_-]{12,}/g, '[REDACTED]');
    for (const secret of secrets.filter(Boolean)) clean = clean.split(secret).join('[REDACTED]');
    return clean.slice(0, 8000);
  }
  if (Array.isArray(value)) return value.slice(0,200).map(item => redactLab(item,secrets));
  if (plain(value)) return Object.fromEntries(Object.entries(value).slice(0,50).map(([key,item]) => [key,
    /token|key|secret|authorization|cookie|password/i.test(key) && key !== 'idempotencyKey' ? '[REDACTED]' : redactLab(item,secrets)]));
  return value;
}

export function createToyApi(workspace, { secrets = [], maxRecords = MAX_API_RECORDS } = {}) {
  const records = [], writes = new Map();
  let serial = 0;
  return {
    records: () => structuredClone(records),
    async request({ method, query = {}, payload, requestId, actionId, resource = 'records' }) {
      const started = performance.now();
      let status = 200, body;
      const fail = (code, error) => { status = code; body = {ok:false,error}; };
      const reservation = resource === 'reservations';
      const expected = reservation ? 'toy.create_reservation' : method === 'GET' ? 'toy.read_record' : 'toy.create_record';
      if (!['records','reservations'].includes(resource) || !requestIdValid(requestId) || actionId !== expected) fail(400, 'Invalid action, resource or request ID.');
      else if (reservation && method !== 'POST') fail(405, 'Reservations support POST only.');
      else if (method === 'GET') {
        if (!plain(query) || Object.keys(query).some(key => key !== 'entity') || typeof query.entity !== 'string') fail(400, 'Provide only entity.');
        else if (!Object.hasOwn(TEST_RECORDS, query.entity)) fail(404, 'Unknown fictional entity.');
        else body = {ok:true,data:structuredClone(TEST_RECORDS[query.entity]),message:JSON.stringify(TEST_RECORDS[query.entity])};
      } else if (method === 'POST') {
        const valid = validateAction({id:expected,params:payload}, TEST_ACTIONS);
        const prior = writes.get(requestId);
        const signature = valid ? JSON.stringify({actionId:expected,params:valid.params}) : null;
        if (!valid) fail(400,reservation ? 'A reservation requires a name (2–100 characters) and a valid YYYY-MM-DD date.' : 'Invalid record type, name, date or amount.');
        else if (prior && prior.payload !== signature) fail(409,'Idempotency key already belongs to another write.');
        else if (prior) { status = 201; body = prior.body; }
        else if (writes.size >= 100) fail(429,'Session write limit reached.');
        else {
          status = 201;
          const recordId=(reservation ? 'TEST-R-' : 'TEST-')+String(++serial).padStart(4,'0');
          body = {ok:true,data:{[reservation ? 'reservationId' : 'recordId']:recordId,...valid.params},message:reservation ? 'Fictional reservation created.' : 'Fictional record created.'};
          writes.set(requestId,{payload:signature,body});
        }
      } else fail(405,'Only GET and POST are supported.');
      const entry = redactLab({ timestamp:new Date().toISOString(), actionId, requestId, method,
        endpoint:'/api/test-lab/sessions/' + path.basename(workspace) + '/toy-db/' + (reservation ? 'reservations' : 'records'), query, requestPayload:payload ?? null, responseStatus:status, responsePayload:body,
        durationMs:Math.round((performance.now()-started)*100)/100, success:status < 400,
        ...(method === 'POST' ? {idempotencyKey:requestId} : {}) }, secrets);
      records.push(entry);
      if (records.length > maxRecords) records.splice(0,records.length-maxRecords);
      // Lifecycle serializes session operations, so persistence cannot race teardown.
      await atomicWrite(path.join(workspace,'api-calls.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
      return {status,body:redactLab(body,secrets)};
    }
  };
}
