import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { labFixture } from '../helpers/test-lab.mjs';
import { createUiServer } from '../../lib/ui-server.mjs';
import { TEST_MARKERS } from '../../lib/test-lab-templates.mjs';

const feedback = [], proposals = [];
let lastCreateProposal;
const fixture = await labFixture(null,{chat:async payload => {
  if (payload.actionResult) {feedback.push(payload.actionResult);return Response.json({reply:'Actual action result: '+payload.actionResult.status});}
  if (payload.message === 'Replay the previous creation proposal') return Response.json(lastCreateProposal);
  const userTurns=[...payload.history.filter(h=>h.role==='user').map(h=>h.content),payload.message];
  const reservationStart=userTurns.findLastIndex(message=>/\b(make|create)\b.*\breservation\b/i.test(message));
  if (reservationStart>=0) {
    const details=userTurns.slice(reservationStart).join('\n');
    const name=details.includes('Ana Torres') ? 'Ana Torres' : null,date=details.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
    if (!name || !date) return Response.json({reply:!name && !date ? 'What name and date would you like for the reservation?' : !name ? 'What name should I use for the reservation?' : 'What date would you like for the reservation?'});
    return Response.json({reply:'I can create that test reservation once you confirm.',action:{id:'toy.create_reservation',params:{name,date}},actionRequestId:randomUUID()});
  }
  let action;
  if (/celebrate/i.test(payload.message)) action={id:'ui.celebrate',params:{}};
  else if (/cry/i.test(payload.message)) action={id:'ui.cry',params:{}};
  else if (/sing/i.test(payload.message)) action={id:'ui.sing',params:{}};
  else if (/write/i.test(payload.message) && /text box/i.test(payload.message)) action={id:'ui.write_text',params:{text:'Falco'}};
  else if (/weekly/i.test(payload.message)) action={id:'toy.read_record',params:{entity:'weekly_expenses'}};
  else if (/expense/i.test(payload.message)) action={id:'toy.create_record',params:{type:'expense',name:'Team Lunch',date:'2026-11-26',amount:35.5}};
  else if (/create/i.test(payload.message)) action={id:'toy.create_record',params:{type:'customer',name:'Browser Customer'}};
  if(action) proposals.push(action.id);
  const result={reply:action ? 'Proposing '+action.id : 'Falco Test Lab online.',...(action ? {action,actionRequestId:randomUUID()} : {})};
  if (action?.id === 'toy.create_record') lastCreateProposal=result;
  return Response.json(result);
}});
const originalConfig = JSON.parse(await fs.readFile(path.join(fixture.project.output,'wrangler.json')));
const runner={session:fixture.sessionReader,remoteReader:fixture.remoteReader,preview:fixture.dependencies.preview,previewFetch:fixture.fetcher,testLabEnv:{},
  authDiagnostics:async()=>({connected:true,factoryCompatible:true,accounts:[{id:fixture.accountId,name:'Fixture account'}],selectedAccount:fixture.accountId}),
  connections:{list:async()=>[]},
  cloudWorkers:async()=>({accountId:fixture.accountId,workers:[{name:fixture.project.name}]}),
  workerEndpoint:async()=>`https://${fixture.project.name}.demo.workers.dev/chat`,
  readDeployedProject:async()=>({vars:originalConfig.vars,origins:fixture.project.origins,actions:fixture.project.actions,knowledgeMode:'embedded',
    knowledge:{faq:fixture.project.faq,instructions:fixture.project.instructions},settings:{bindings:[]},remote:fixture.production})};
let app=createUiServer({root:fixture.root,port:0,runner});
let url=await app.listen();
const browser=await chromium.launch({headless:true,...(process.env.FALCO_CHROMIUM ? {executablePath:process.env.FALCO_CHROMIUM} : {})});
const context=await browser.newContext({reducedMotion:'reduce'});
const page=await context.newPage(),errors=[];
page.on('pageerror',error=>errors.push(error.message));
let accept=true;const dialogs=[];
page.on('dialog',async dialog=>{dialogs.push(dialog.message());if(accept)await dialog.accept();else await dialog.dismiss();});
// Hold remote creation until the browser has actually observed preparing.
// Fast fixtures previously jumped straight to ready and hid the controller bug.
const createPreview = fixture.dependencies.preview.create;
let releaseCreation;
const creationHeld = new Promise(resolve=>{releaseCreation=resolve;});
fixture.dependencies.preview.create = async (...args) => {await creationHeld;return createPreview(...args);};
try {
  await page.goto(url);await page.locator('#sidebarManage').click();
  await page.locator('#manageProject').selectOption(fixture.project.folder);
  await page.locator('#openTestLab').waitFor({state:'visible'});
  // The lights travel on the drawn ellipses at both viewport sizes.
  await page.emulateMedia({reducedMotion:'no-preference'});
  for (const width of [1280,390]) {
    await page.setViewportSize({width,height:900});
    const orbits=await page.locator('.manage-hero .orbit-point').evaluateAll(points=>points.map(point=>{
      const orbit=point.parentElement,animation=point.getAnimations()[0];
      if (!animation) return {animated:false};
      const front=point.classList.contains('second') ? orbit.parentElement.querySelector('.orbit-light-front') : null;
      const frontAnimation=front?.getAnimations()[0];
      animation.pause();
      frontAnimation?.pause();
      const matrix=new DOMMatrix(getComputedStyle(orbit).transform),bounds=orbit.getBoundingClientRect();
      const samples=[0,.17,.38,.64,.89].map(fraction=>{
        animation.currentTime=Number(animation.effect.getTiming().duration)*fraction;
        if (frontAnimation) frontAnimation.currentTime=animation.currentTime;
        const dot=point.getBoundingClientRect();
        const dx=dot.x+dot.width/2-(bounds.x+bounds.width/2),dy=dot.y+dot.height/2-(bounds.y+bounds.height/2);
        const x=matrix.a*dx+matrix.b*dy,y=matrix.c*dx+matrix.d*dy;
        const foreground=front?.getBoundingClientRect();
        return {x,y,radius:(x/(orbit.offsetWidth/2))**2+(y/(orbit.offsetHeight/2))**2,
          aligned:!front || (Math.abs(foreground.x-dot.x)<.1 && Math.abs(foreground.y-dot.y)<.1)};
      });
      animation.play();frontAnimation?.play();return {animated:true,samples};
    }));
    assert.equal(orbits.length,2);
    for (const orbit of orbits) {
      assert.equal(orbit.animated,true,'Each light has an orbital animation');
      for (const sample of orbit.samples) {
        assert.ok(Math.abs(sample.radius-1)<.06,`Light follows the ellipse at ${width}px: ${JSON.stringify(sample)}`);
        assert.equal(sample.aligned,true,'Foreground and background arcs share one light trajectory');
      }
      assert.ok(Math.hypot(orbit.samples[0].x-orbit.samples[2].x,orbit.samples[0].y-orbit.samples[2].y)>20,'Light moves around the orbit');
    }
  }
  await page.setViewportSize({width:1280,height:900});
  if (process.env.FALCO_LAB_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.FALCO_LAB_SCREENSHOT_DIR,{recursive:true});
    await page.locator('.manage-hero').evaluate(hero=>{
      for (const point of hero.querySelectorAll('.orbit-point.second,.orbit-light-front')) {
        const animation=point.getAnimations()[0];animation.pause();animation.currentTime=8800;
      }
    });
    await page.locator('.manage-hero').screenshot({path:path.join(process.env.FALCO_LAB_SCREENSHOT_DIR,'orbits.png')});
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.deepEqual(await page.locator('.manage-hero .orbit-point,.manage-hero .orbit-light-front').evaluateAll(points=>points.map(point=>point.getAnimations().length)),[0,0,0],'Reduced motion keeps both lights and the foreground layer still');
  if (process.env.FALCO_LAB_SCREENSHOT_DIR) {await fs.mkdir(process.env.FALCO_LAB_SCREENSHOT_DIR,{recursive:true});await page.locator('#testLabLaunchCard').screenshot({path:path.join(process.env.FALCO_LAB_SCREENSHOT_DIR,'launch.png')});}
  const original = await fs.readFile(path.join(fixture.project.output,'wrangler.json'));
  await page.locator('#manageFaq').fill('Unsaved knowledge must stay here.');
  const values=await page.locator('#manageEditorPanel').evaluate(panel=>[...panel.querySelectorAll('textarea')].map(node=>node.value));
  accept=false;await page.locator('#openTestLab').click();assert.equal(await page.locator('#testLabLaunch').isVisible(),false);
  accept=true;await page.locator('#openTestLab').click();await page.locator('#labKey').fill('dedicated-provider-key');
  await page.locator('#labLaunchForm button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#testLabPanel').dataset.state==='preparing');
  assert.equal(await page.locator('#labSend').isDisabled(),true,'Chat stays disabled until the ready controller exists');
  releaseCreation();
  await page.waitForFunction(()=>document.querySelector('#testLabPanel').dataset.state==='ready');
  assert.equal(await page.locator('#testLabStatus').innerText(),'Ready to test');
  assert.equal(await page.locator('#labWorkerName').innerText(),fixture.project.name);
  assert.equal(await page.locator('#labHealthLabel').innerText(),'Verified and connected');
  assert.equal(await page.locator('#labEnd svg').count(),1,'The End Test icon survives state updates');
  if (process.env.FALCO_LAB_SCREENSHOT_DIR) await page.locator('.lab-session-header').screenshot({path:path.join(process.env.FALCO_LAB_SCREENSHOT_DIR,'session-header.png')});
  assert.equal(await page.locator('#labKey').inputValue(),'');
  assert.equal(await page.locator('#manageEditorPanel').isVisible(),false);
  accept=false;await page.locator('#sidebarCreate').click();assert.equal(await page.locator('#manageView').isVisible(),true);
  accept=true;await page.locator('#sidebarCreate').click();await page.locator('#testLabReturn').click();
  assert.deepEqual(await page.locator('#manageEditorPanel').evaluate(panel=>[...panel.querySelectorAll('textarea')].map(node=>node.value)),values);
  assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),true);
  const manualMessages=fixture.messages.length,manualFeedback=feedback.length,chatRows=await page.locator('#labConversation > *').count();
  for(const effect of ['Celebrate','Cry','Sing']) {
    await page.getByRole('button',{name:effect,exact:true}).click();
    await page.waitForFunction(effect=>document.querySelector('#labEffect').dataset.effect===effect,effect.toLowerCase());
    assert.equal(fixture.messages.length,manualMessages,'Manual buttons never contact Falco');
    assert.equal(feedback.length,manualFeedback);assert.equal(await page.locator('#labConversation > *').count(),chatRows);
  }
  for(const effect of ['Celebrate','Cry','Sing']) {
    await page.locator('#labMessage').fill('Please '+effect.toLowerCase()+'!');await page.locator('#labSend').click();
    await page.waitForFunction(effect=>document.querySelector('#labEffect').dataset.effect===effect,effect.toLowerCase());
    await page.waitForFunction(()=>!document.querySelector('#labSend').disabled);
    assert.equal(feedback.at(-1).status,'success');
  }
  await page.locator('#labTargetText').fill('Typed by me');
  assert.equal(fixture.messages.length,manualMessages+6,'Typing in the playground does not contact Falco');
  await page.locator('#labMessage').fill('Write the word Falco in the text box.');await page.locator('#labSend').click();
  await page.waitForFunction(()=>document.querySelector('#labTargetText').value==='Falco' && !document.querySelector('#labSend').disabled);
  assert.equal(feedback.at(-1).action.id,'ui.write_text');assert.equal(feedback.at(-1).data.text,'Falco');
  assert.equal(await page.locator('#labTargetText').inputValue(),'Falco');
  await page.locator('[data-lab-suggestion=expenses]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.lab-api-call').length===1);
  await page.waitForFunction(()=>!document.querySelector('#labSend').disabled);
  assert.equal(feedback.at(-1).data.total,1245.80);
  assert.match(await page.locator('#labInspector').textContent(),/GET.*HTTP 200/);
  const expensePrompt='Create an expense named Team Lunch with an amount of 35.50 and date 2026-11-26';
  await page.locator('#labMessage').fill(expensePrompt);await page.locator('#labSend').click();
  const card=page.locator('.lab-action-card').last();await card.waitFor({state:'visible'});
  const cardText=await card.innerText();
  assert.match(cardText,/Create this test expense\?/);assert.match(cardText,/Team Lunch.*35\.50.*November 26, 2026/);
  assert.doesNotMatch(cardText,/toy\.create_record|"params"/,'Confirmation is natural language with collapsed technical details');
  await page.locator('[data-lab-confirm=no]:not([disabled])').click();
  await page.waitForFunction(()=>!document.querySelector('#labSend').disabled);assert.equal(feedback.at(-1).status,'cancelled');
  assert.equal(await page.locator('.lab-api-call').count(),1,'cancelled writes do not reach Toy API');
  await page.locator('#labMessage').fill(expensePrompt);await page.locator('#labSend').click();
  await page.locator('[data-lab-confirm=yes]:not([disabled])').click();
  await page.waitForFunction(()=>document.querySelectorAll('.lab-api-call').length===2);
  await page.waitForFunction(()=>!document.querySelector('#labSend').disabled);
  assert.match(await page.locator('#labInspector').textContent(),/POST.*HTTP 201/);
  assert.equal(feedback.at(-1).status,'success');assert.match(feedback.at(-1).data.recordId,/TEST-/);
  // Readiness polls must preserve the controller's idempotency ledger.
  const previousRequestId=feedback.at(-1).requestId,feedbackCount=feedback.length;
  await page.waitForResponse(response=>new URL(response.url()).pathname === '/api/test-lab/status');
  await page.locator('#labMessage').fill('Replay the previous creation proposal');await page.locator('#labSend').click();
  await page.locator('[data-lab-confirm=yes]:not([disabled])').click();
  await page.waitForFunction(()=>!document.querySelector('#labSend').disabled);
  assert.equal(feedback.length,feedbackCount+1);assert.equal(feedback.at(-1).requestId,previousRequestId);
  assert.equal(await page.locator('.lab-api-call').count(),2,'Replayed proposal after a poll does not execute the Toy API again');
  // A suggestion is a chat prompt. Missing reservation details never execute an API call.
  await page.locator('[data-lab-suggestion=reservation-missing]').click();
  await page.waitForFunction(()=>!document.querySelector('#labSend').disabled);
  assert.match(await page.locator('.lab-assistant').last().innerText(),/name and date/);
  assert.equal(await page.locator('.lab-api-call').count(),2);assert.equal(await page.locator('[data-lab-confirm=yes]:not([disabled])').count(),0);
  await page.locator('#labMessage').fill('My name is Ana Torres.');await page.locator('#labSend').click();
  await page.waitForFunction(()=>!document.querySelector('#labSend').disabled);
  assert.match(await page.locator('.lab-assistant').last().innerText(),/What date/);
  assert.equal(await page.locator('.lab-api-call').count(),2);
  await page.locator('#labMessage').fill('2027-01-15');await page.locator('#labSend').click();
  await page.locator('[data-lab-confirm=yes]:not([disabled])').waitFor({state:'visible'});
  assert.match(await page.locator('.lab-action-card').last().innerText(),/Ana Torres.*January 15, 2027/);
  assert.equal(await page.locator('.lab-api-call').count(),2,'No reservation write before confirmation');
  await page.locator('[data-lab-confirm=no]:not([disabled])').click();await page.waitForFunction(()=>!document.querySelector('#labSend').disabled);
  assert.equal(feedback.at(-1).status,'cancelled');assert.equal(await page.locator('.lab-api-call').count(),2);
  await page.locator('[data-lab-suggestion=reservation-complete]').click();
  await page.locator('[data-lab-confirm=yes]:not([disabled])').click();
  await page.waitForFunction(()=>!document.querySelector('#labSend').disabled);
  assert.equal(feedback.at(-1).status,'success');assert.match(feedback.at(-1).data.reservationId,/TEST-R-/);
  assert.equal(await page.locator('.lab-api-call').count(),3);assert.match(await page.locator('.lab-api-call').last().innerText(),/POST.*201/);
  if (process.env.FALCO_LAB_SCREENSHOT_DIR) await page.locator('#testLabPanel').screenshot({path:path.join(process.env.FALCO_LAB_SCREENSHOT_DIR,'playground.png')});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth),true,'Lab fits mobile viewport');
  if (process.env.FALCO_LAB_SCREENSHOT_DIR) await page.locator('.lab-session-header').screenshot({path:path.join(process.env.FALCO_LAB_SCREENSHOT_DIR,'session-header-mobile.png')});
  await page.setViewportSize({width:1280,height:900});
  await page.locator('#labEnd').click();
  await page.locator('#testLabPanel').waitFor({state:'hidden'});
  assert.deepEqual(await page.locator('#manageEditorPanel').evaluate(panel=>[...panel.querySelectorAll('textarea')].map(node=>node.value)),values);
  assert.equal(fixture.cloud.size,0);
  assert.deepEqual(await fs.readFile(path.join(fixture.project.output,'wrangler.json')),original);
  assert.ok(dialogs.some(message=>message.includes('unsaved editor changes')));
  assert.deepEqual(proposals.slice(0,3),['ui.celebrate','ui.cry','ui.sing']);
  // Force server restart with a live Preview; the replacement server has no session token.
  await page.locator('#openTestLab').waitFor({state:'visible'});await page.locator('#openTestLab').click();
  await page.locator('#labKey').fill('dedicated-provider-key');await page.locator('#labLaunchForm button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#testLabPanel').dataset.state==='ready');
  // A reload attaches to an already-ready session on the same server. It must
  // rebuild the controller without ending the Preview or requesting another key.
  const feedbackBeforeReload=feedback.length;
  await page.reload();await page.locator('#sidebarManage').click();
  await page.waitForFunction(()=>document.querySelector('#testLabPanel').dataset.state==='ready');
  await page.locator('#labMessage').fill('i want you to celebrate');await page.locator('#labSend').click();
  await page.waitForFunction(()=>document.querySelector('#labEffect').dataset.effect === 'celebrate' && !document.querySelector('#labSend').disabled);
  assert.equal(feedback.length,feedbackBeforeReload+1);assert.equal(feedback.at(-1).action.id,'ui.celebrate');assert.equal(feedback.at(-1).status,'success');
  assert.equal(await page.locator('.lab-error').count(),0);
  await app.close();
  app=createUiServer({root:fixture.root,port:0,runner});url=await app.listen();
  await page.goto(url);await page.locator('#sidebarManage').click();
  await page.waitForFunction(()=>document.querySelector('#testLabPanel').dataset.state==='cleanup_required');
  assert.equal(await page.locator('#labSend').isDisabled(),true);
  await page.getByRole('button',{name:'Retry cleanup',exact:true}).click();
  await page.locator('#testLabPanel').waitFor({state:'hidden'});assert.equal(fixture.cloud.size,0);
  await fs.writeFile(path.join(fixture.project.output,'src/business-context.mjs'),`export const businessInstructions = ${JSON.stringify(TEST_MARKERS.instructions)};\nexport const faqText = "Safe";\n`);
  await page.evaluate(folder=>fetch('/api/projects/'+folder),fixture.project.folder);
  await page.locator('#testLabEmergency').waitFor({state:'visible'});
  assert.match(await page.locator('#testLabEmergency').textContent(),/EMERGENCY MODE.*instructions/);
  assert.equal(await page.locator('#manageView .manage-grid').evaluate(node=>node.inert),true);
  assert.deepEqual(errors,[]);
  console.log('Test Lab browser checks passed: preparing-to-ready controller initialization, eligibility, unsaved buffer, three real-proxy proposal flows, GET, confirmed/cancelled POST, Inspector, End Test, beforeunload and restart cleanup. Cloudflare/provider adapters were mocked.');
} catch (error) {
  console.error('Browser diagnostics:',JSON.stringify({errors,conversation:await page.locator('#labConversation').textContent(),progress:await page.locator('#labProgress').textContent()}));
  throw error;
} finally {
  releaseCreation();
  await context.close();await browser.close();await app.close();await fs.rm(fixture.root,{recursive:true,force:true});
}
