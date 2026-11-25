import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import worker from '../../templates/worker/src/index.mjs';
import { normalizeActions } from '../../templates/worker/src/action-contract.mjs';
import { reservationAction } from '../../frontend-kit-template/integration/reservation-actions.example.js';
import { createUiServer } from '../../lib/ui-server.mjs';

const manifest=normalizeActions([reservationAction]);
const template=fileURLToPath(new URL('../../frontend-kit-template/',import.meta.url));
const nativeFetch=globalThis.fetch, providerRequests=[], receipts=[], posted=[], errors=[];
let mode='success',url, browser;
const env={BUSINESS_NAME:'Reservas',PROVIDER:'openai',MODEL:'fixture',OPENAI_API_KEY:'FAKE_PRIVATE_PROVIDER_KEY',CLIENT_ACTIONS_JSON:JSON.stringify(manifest),CHAT_RATE_LIMITER:{limit:async()=>({success:true})}};
globalThis.fetch=async(target,options)=>{
  if(!String(target).startsWith('https://api.openai.com/'))return nativeFetch(target,options);
  const payload=JSON.parse(options.body);providerRequests.push(payload);
  let reply,action=null;
  if(payload.instructions.includes('UNTRUSTED CLIENT-REPORTED ACTION RESULT')){
    const result=JSON.parse(payload.instructions.slice(payload.instructions.lastIndexOf('\n')+1));receipts.push(result);
    reply=result.status==='success'?'Reserva confirmada: '+result.data.reservationId:result.status==='cancelled'?'La reserva fue cancelada sin enviarse.':result.status==='unknown'?'No se pudo confirmar la reserva. Verifica su estado antes de repetirla.':'Esa fecha no está disponible. ¿Qué otra fecha prefieres?';
    // Deliberately propose a duplicate: the Worker must suppress continuation actions.
    action={id:'reservation.create',params:result.action.params};
  }else{
    const message=payload.input.at(-1).content;
    if(message.includes('Me llamo'))reply='Hola Carlos. ¿En qué puedo ayudarte?';
    else if(message==='Quiero reservar')reply='¿Para qué fecha deseas reservar?';
    else {
      assert.ok(payload.input.some(turn=>turn.content.includes('Carlos')),'name is available in conversation history');
      reply='Revisa el nombre y la fecha antes de confirmar.';
      action={id:'reservation.create',params:{name:'Carlos',date:message.includes('16')?'2027-01-16':'2027-01-15'}};
    }
  }
  return Response.json({output_text:JSON.stringify({reply,action})});
};
const server=http.createServer(async(req,res)=>{
  try {
    const endpoint=new URL(req.url,'http://localhost').pathname;
    if(endpoint==='/'){
      res.writeHead(200,{'Content-Type':'text/html'});
      res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/widget/falco-widget.css"><div id="demo"></div><script type="module">
        import {mountFalcoWidget} from '/widget/falco-widget.js';
        import {reservationHandlers} from '/integration/reservation-actions.example.js';
        const api={createReservation:async (params,{idempotencyKey,signal})=>{
          const response=await fetch('/api/reservations',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:JSON.stringify(params),signal});return response.json();
        }};
        window.widget=await mountFalcoWidget('#demo',{endpoint:location.origin+'/chat',actionHandlers:reservationHandlers(api)});
      </script>`);return;
    }
    if(endpoint==='/api/reservations'){
      assert.equal(req.method,'POST');
      const params=JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());posted.push({params,idempotencyKey:req.headers['idempotency-key']});
      if(mode==='uncertain'){res.destroy();return;}
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(mode==='error'?{ok:false,privateToken:'DO_NOT_SEND_TO_MODEL'}:{ok:true,reservationId:'RES-123',date:params.date,privateToken:'DO_NOT_SEND_TO_MODEL'}));return;
    }
    if(endpoint==='/chat'){
      const text=Buffer.concat(await Array.fromAsync(req)).toString(), body=JSON.parse(text);
      if(body.actionResult && mode==='feedback-failure'){res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"provider_unavailable"}');return;}
      const response=await worker.fetch(new Request(url+'/chat',{method:'POST',headers:{'Content-Type':'application/json',Origin:url},body:text}),env);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
    }
    const relative=endpoint.slice(1), file=path.resolve(template,relative);
    if(!file.startsWith(path.resolve(template)+path.sep)||!/^[-a-z./]+\.(?:js|css|html)$/.test(relative)){res.writeHead(404);res.end();return;}
    let content=await fs.readFile(file,'utf8');
    if(relative==='actions/actions.manifest.js')content=content.replace('__FALCO_ACTIONS__',JSON.stringify(manifest));
    if(relative==='config/falco.config.js')content=content.replace('__FALCO_CONFIG__',JSON.stringify({endpoint:url+'/chat'}));
    res.writeHead(200,{'Content-Type':relative.endsWith('.js')?'application/javascript':relative.endsWith('.css')?'text/css':'text/html'});res.end(content);
  }catch(error){errors.push(error.message);res.writeHead(500);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));url='http://127.0.0.1:'+server.address().port;env.ALLOWED_ORIGIN=url;
const studioRoot=await fs.mkdtemp(path.join(os.tmpdir(),'falco-api-browser-'));
const studio=createUiServer({root:studioRoot,port:0,runner:{authDiagnostics:async()=>({connected:false,accounts:[]}),connections:{list:async()=>[]}}});
try {
  browser=await chromium.launch({...(process.env.FALCO_CHROMIUM?{executablePath:process.env.FALCO_CHROMIUM}:{}),headless:true});
  async function scenario(type){
    mode=type;posted.length=0;
    const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(url);await page.locator('[data-falco-launcher]').click();
    const send=async text=>{await page.locator('[data-falco-input]').fill(text);await page.locator('[data-falco-send]').click();await page.waitForFunction(()=>document.querySelectorAll('.falco__bubble--assistant').length>0&&!document.querySelector('[data-falco-send]').disabled);};
    await send('Me llamo Carlos');await send('Quiero reservar');
    assert.match(await page.locator('[data-falco-messages]').innerText(),/¿Para qué fecha/);
    await page.locator('[data-falco-input]').fill(type==='error'?'16 de enero de 2027':'15 de enero de 2027');await page.locator('[data-falco-send]').click();
    await page.locator('[data-falco-confirm]').waitFor();assert.equal(posted.length,0);
    assert.match(await page.locator('.falco__confirmation').innerText(),/Carlos/);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    if(type==='cancel')await page.locator('[data-falco-cancel]').click();
    else if(type==='destroy'){await page.evaluate(()=>window.widget.destroy());await page.waitForTimeout(100);assert.equal(posted.length,0);await page.close();return;}
    else await page.locator('[data-falco-confirm]').evaluate(button=>{button.click();button.click();});
    await page.waitForFunction(()=>!document.querySelector('[data-falco-send]').disabled);
    const transcript=await page.locator('[data-falco-messages]').innerText();
    if(type==='cancel'){assert.equal(posted.length,0);assert.match(transcript,/cancelada sin enviarse/);}
    else {
      assert.equal(posted.length,1);assert.equal(posted[0].params.name,'Carlos');assert.match(posted[0].idempotencyKey,/^[a-f0-9-]{36}$/);
      assert.match(transcript,type==='error'?/fecha no está disponible/:type==='uncertain'?/No se pudo confirmar/:/RES-123/);
      if(type==='feedback-failure')assert.match(await page.locator('[data-falco-status]').innerText(),/resultado reportado/);
    }
    assert.doesNotMatch(transcript,/DO_NOT_SEND_TO_MODEL|FAKE_PRIVATE_PROVIDER_KEY/);await page.close();
  }
  for(const type of ['success','error','cancel','uncertain','feedback-failure','destroy'])await scenario(type);
  assert.doesNotMatch(JSON.stringify(providerRequests),/DO_NOT_SEND_TO_MODEL/);
  const studioUrl=await studio.listen();const page=await browser.newPage({reducedMotion:'reduce'});page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(studioUrl);await page.locator('#createVisualActions').click();
  const row=page.locator('.action-form-row');await row.getByLabel('Action ID',{exact:true}).fill('reservation.create');await row.getByLabel('Description',{exact:true}).fill(reservationAction.description);
  await row.getByLabel('Public result fields (comma separated)').fill('reservationId, date');
  for(const[index,name,type]of [[0,'name','string'],[1,'date','date']]){
    const detail=row.locator('fieldset details').nth(index);await detail.evaluate(el=>{el.open=true;});await detail.getByLabel('Name',{exact:true}).fill(name);await detail.getByLabel('Type',{exact:true}).selectOption(type);
  }
  await page.locator('#applyActions').click();
  const configured=JSON.parse(await page.locator('#actions').inputValue())[0];assert.equal(configured.requiresConfirmation,true);assert.equal(configured.parameters.name.type,'string');assert.equal(configured.parameters.date.type,'date');
  await page.close();assert.deepEqual(errors,[]);
  console.log('API action browser E2E passed: conversational collection, real backend POST, confirmation, replay protection, success/error/cancel/unknown, failed AI continuation, public result projection and Studio typed editor.');
}finally{
  await browser?.close();await studio.close();await new Promise(resolve=>server.close(resolve));globalThis.fetch=nativeFetch;await fs.rm(studioRoot,{recursive:true,force:true});
}
