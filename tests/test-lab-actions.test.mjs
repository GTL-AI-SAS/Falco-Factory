import test from 'node:test';
import assert from 'node:assert/strict';
import {describeLabAction,describeLabResult} from '../ui/test-lab-actions.js';
import {TEST_ACTIONS,TEST_INSTRUCTIONS} from '../lib/test-lab-templates.mjs';
import {validateAction,validateActionResult} from '../templates/worker/src/action-contract.mjs';
import {randomUUID} from 'node:crypto';

test('expense confirmation states the intended write, amount and date in natural language',()=>{
  const action={id:'toy.create_record',params:{type:'expense',name:'Team Lunch',amount:35.5,date:'2026-11-26'}};
  const summary=describeLabAction(action);
  assert.equal(summary.title,'Create this test expense?');assert.equal(summary.confirmLabel,'Create expense');
  assert.equal(summary.description,'Create a fictional expense named “Team Lunch” with an amount of 35.50, dated November 26, 2026.');
  assert.equal(describeLabAction({id:'toy.create_record',params:{type:'customer',name:'Ana'}}).description,'Create a fictional customer named “Ana”.');
});

test('action outcomes distinguish success, cancellation, failure and uncertainty',()=>{
  const action={id:'toy.create_record',params:{type:'expense',name:'Team Lunch'}};
  assert.equal(describeLabResult(action,{status:'success',data:{recordId:'TEST-0001'}}),'Created the test expense “Team Lunch” (ID TEST-0001).');
  assert.equal(describeLabResult(action,{status:'cancelled'}),'Action cancelled.');
  assert.equal(describeLabResult(action,{status:'error'}),'The action could not be completed.');
  assert.equal(describeLabResult(action,{status:'unknown'}),'The action’s outcome could not be confirmed.');
});

test('text box action accepts bounded text and cannot select another target or execute code',()=>{
  const spec=TEST_ACTIONS.find(a=>a.id==='ui.write_text');
  assert.equal(TEST_ACTIONS.length,7);assert.equal(spec.requiresConfirmation,false);
  const action={id:spec.id,params:{text:'Falco'}};
  assert.deepEqual(validateAction(action,TEST_ACTIONS),action);
  for(const params of [{text:''},{text:'x'.repeat(101)},{text:'Falco',selector:'#other'},{text:'Falco',javascript:'alert(1)'}]) assert.equal(validateAction({id:spec.id,params},TEST_ACTIONS),null);
  assert.ok(validateActionResult({requestId:randomUUID(),action,status:'success',data:{text:'Falco'}},TEST_ACTIONS));
  assert.equal(describeLabResult(action,{status:'success',data:{text:'Falco'}}),'Wrote “Falco” in the playground text box.');
  assert.match(TEST_INSTRUCTIONS,/ui\.write_text/);
});

test('reservation requires both explicit name and valid date before confirmation or execution',()=>{
  const spec=TEST_ACTIONS.find(a=>a.id==='toy.create_reservation');
  assert.equal(spec.requiresConfirmation,true);
  for(const params of [{},{name:'Ana Torres'},{date:'2027-01-15'},{name:'Ana Torres',date:'2027-02-30'},{name:'Ana Torres',date:'tomorrow'}]) assert.equal(validateAction({id:spec.id,params},TEST_ACTIONS),null);
  const action={id:spec.id,params:{name:'Ana Torres',date:'2027-01-15'}};
  assert.deepEqual(validateAction(action,TEST_ACTIONS),action);
  assert.equal(describeLabAction(action).description,'Create a fictional reservation for “Ana Torres” on January 15, 2027.');
  assert.equal(describeLabAction(action).confirmLabel,'Create reservation');
  assert.match(describeLabResult(action,{status:'success',data:{reservationId:'TEST-R-0001'}}),/TEST-R-0001/);
  assert.match(TEST_INSTRUCTIONS,/If only one is provided, ask for the other/);
});
