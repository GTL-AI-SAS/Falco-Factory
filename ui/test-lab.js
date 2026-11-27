import { createActionController } from './actions/action-controller.js';
import { describeLabAction, describeLabResult, EFFECT_MESSAGES, LAB_SUGGESTIONS } from './test-lab-actions.js';

export function createTestLabUi({ api, getToken, getProject, getModels, hasEdits, isBusy, returnToManage, editorChanged }) {
  const $ = id => document.getElementById(id);
  let session = null, working = false, launching = false, emergencies = [], controller, eligibility = false;
  let controllerSessionId = null, statusSerial = 0;
  let history = [], turn = 0, cancelConfirmation;
  const panel = $('testLabPanel'), banner = $('testLabBanner'), launch = $('testLabLaunch');
  const text = (tag, content, className) => {
    const node = document.createElement(tag); node.textContent = content;
    if (className) node.className = className;
    return node;
  };
  const technicalDetails = value => {
    const details = document.createElement('details');details.className='lab-action-details';
    details.append(text('summary','Technical details'),text('pre',JSON.stringify(value,null,2)));
    return details;
  };
  const message = (role, content, details) => {
    const row = text('div',content,'lab-message lab-' + role);
    row.prepend(text('strong',({assistant:'Falco',user:'You',proposal:'Suggested action',result:'Action result',error:'Error'})[role] ?? role));
    if (details) row.append(technicalDetails(details));
    $('labConversation').append(row);
    while ($('labConversation').children.length > 100) $('labConversation').firstChild.remove();
    row.scrollIntoView({block:'nearest'});
  };
  function controls() {
    const ready = session?.state === 'ready' && controller && controllerSessionId === session.id && !working && !emergencies.length;
    for (const node of panel.querySelectorAll('#labMessage, #labSend, [data-lab-suggestion]')) node.disabled = !ready;
    const playgroundReady = session?.state === 'ready' && !launching && !emergencies.length;
    for (const node of panel.querySelectorAll('[data-lab-effect], #labTargetText')) node.disabled = !playgroundReady;
    $('labEnd').disabled = launching || !session || session.state === 'ending';
    const hasProject = Boolean(getProject());
    $('openTestLab').hidden = !hasProject || Boolean(session) || emergencies.length > 0;
    $('testLabLaunchCard').hidden = $('openTestLab').hidden;
    $('openTestLab').disabled = isBusy() || working || !eligibility;
    const state=session?.state ?? (launching ? 'preparing' : 'idle');
    panel.dataset.state=state;
    $('testLabStatus').textContent=({ready:'Ready to test',preparing:'Preparing Preview',ending:'Ending test',cleanup_required:'Cleanup needed',emergency:'Integrity review',idle:'No active test'})[state];
    $('labWorkerName').textContent=session?.workerName ?? getProject()?.name ?? 'Preparing…';
    $('labPreviewName').textContent=session?.previewName ?? 'Creating a private test space…';
    $('labProviderName').textContent=({gemini:'Gemini',openai:'OpenAI'})[session?.provider] ?? '';
    $('labModelName').textContent=session?.model ?? '';
    $('labHealthLabel').textContent=session?.health === 'verified' ? 'Verified and connected' : 'Not checked yet';
    $('labHealthLabel').classList.toggle('verified',session?.health === 'verified');
    banner.hidden = !session && !launching && !emergencies.length;
    $('testLabBannerText').textContent = session ? `Test Lab active: ${session.workerName} · ${session.state}. End Test to confirm Preview cleanup before leaving.` : launching ? 'Creating Test Lab. Keep Studio open.' : 'EMERGENCY MODE: Production integrity review is required.';
    $('testLabRecovery').textContent = session?.state === 'cleanup_required' ? session.reason + ' Chat cannot resume after restart; use Retry cleanup.' : '';
    const cleanup=session?.state === 'cleanup_required' || session?.state === 'emergency';
    $('labEndLabel').textContent=cleanup ? 'Retry cleanup' : 'End Test';
    $('labExitHelp').textContent=state === 'ending' ? 'Verifying cleanup…' : cleanup ? 'Finish removing the Preview' : 'Delete this temporary Preview';
    $('testLabEmergency').hidden = !emergencies.length;
    $('testLabEmergency').replaceChildren(...emergencies.map(e => {
      const box = text('div',''); box.append(text('h2','EMERGENCY MODE'),text('p',e.reason),
        text('p',`${e.workerName} · Account ${e.accountId}${e.previewName ? ' · ' + e.previewName : ''}${e.sessionId ? ' · Session ' + e.sessionId : ''}`),text('p',e.action));
      return box;
    }));
    const active = Boolean(session || launching);
    panel.hidden = !active;
    $('manageView').classList.toggle('lab-view-active',active);
    document.querySelector('#manageView .manage-grid').inert = active || emergencies.length > 0;
    $('createView').inert = active || emergencies.length > 0;
  }
  async function status() {
    const serial = ++statusSerial;
    const data = await api('/api/test-lab/status');
    if (serial !== statusSerial) return data;
    emergencies = data.emergencies;
    const next = data.sessions[0] ?? null;
    if (next?.id !== session?.id) {
      ++turn; cancelConfirmation?.();
      history = []; $('labConversation').replaceChildren();
      controller = null; controllerSessionId = null;
    }
    session = next;
    // Real deployments are observed while preparing. Initialize on readiness,
    // then retain the controller across polls so its invocation ledger survives.
    if (next?.state === 'ready' && (!controller || controllerSessionId !== next.id)) {
      try {controller = makeController(next); controllerSessionId = next.id;}
      finally {controls();}
    }
    $('labKey').required = !data.hasEnvironmentKey;
    $('labKeyArea').hidden = data.hasEnvironmentKey;
    controls();
    return data;
  }
  async function projectLoaded() {
    eligibility = false; $('testLabEligibility').textContent = 'Checking Test Lab eligibility…'; controls();
    const project = getProject();
    if (!project || session || launching) return;
    const result = await api(`/api/test-lab/projects/${encodeURIComponent(project.folder)}/eligibility`);
    if (getProject() !== project) return;
    eligibility = result.eligible;
    $('testLabEligibility').textContent = result.eligible ? 'Verified managed Worker · isolated Preview ready.' : `Unavailable: ${result.reason ?? 'Worker verification failed.'}`;
    $('openTestLab').title = result.reason ?? 'Open an isolated Worker Preview';
    await status(); controls();
  }
  async function waitJob(job) {
    let current = job;
    while (!['ready','failed'].includes(current.status)) {
      await new Promise(resolve => setTimeout(resolve,400));
      ({job:current} = await api('/api/jobs/' + job.id));
      $('labProgress').textContent = current.events.map(e => e.message).join('\n');
      await status();
    }
    if (current.status === 'failed') throw Error(current.error);
  }
  function playEffect(effect) {
    if (!Object.hasOwn(EFFECT_MESSAGES,effect)) return {ok:false,code:'effect_not_allowed'};
    const stage = $('labEffect'); stage.dataset.effect = effect;
    stage.textContent = {celebrate:'🎉 ✨ 🎊',cry:'🌧 💧 🌧',sing:'♫ ♪ ♬'}[effect];
    stage.setAttribute('aria-label',effect + ' effect');
    for (const button of panel.querySelectorAll('[data-lab-effect]')) button.setAttribute('aria-pressed',String(button.dataset.labEffect === effect));
    for (const animation of stage.getAnimations()) {animation.currentTime=0;animation.play();}
    $('labPlaygroundStatus').textContent=EFFECT_MESSAGES[effect];
    return {ok:true,data:{effect},message:EFFECT_MESSAGES[effect]};
  }
  function makeController(active) {
    const effects = Object.fromEntries(['celebrate','cry','sing'].map(effect => ['ui.' + effect,async () => playEffect(effect)]));
    const toy = async (method,params,context,reservation = false) => {
      const url = `/api/test-lab/sessions/${active.id}/toy-db/${reservation ? 'reservations' : 'records'}` + (method === 'GET' ? '?entity=' + encodeURIComponent(params.entity) : '');
      try {
        const response = await fetch(url,{method,cache:'no-store',signal:context.signal,
          headers:{'Content-Type':'application/json','X-Falco-Local-Token':getToken(),
            'X-Falco-Action-Request-Id':context.requestId,'X-Falco-Action-Id':reservation ? 'toy.create_reservation' : method === 'GET' ? 'toy.read_record' : 'toy.create_record'},
          ...(method === 'POST' ? {body:JSON.stringify(params)} : {})});
        const result = await response.json();
        return response.ok ? result : {ok:false,code:'toy_request_failed',message:result.error};
      } finally {await inspector().catch(() => {});}
    };
    return createActionController(active.actions,{...effects,
      'ui.write_text':async ({text:value}) => {
        $('labTargetText').value=value;
        $('labTargetText').dispatchEvent(new Event('input',{bubbles:true}));
        return {ok:true,data:{text:$('labTargetText').value},message:'The playground text box was updated.'};
      },
      'toy.read_record':(params,ctx) => toy('GET',params,ctx),
      'toy.create_reservation':(params,ctx) => toy('POST',params,ctx,true),
      'toy.create_record':(params,ctx) => toy('POST',params,ctx)});
  }
  async function inspector() {
    if (!session) return;
    const {records} = await api(`/api/test-lab/sessions/${session.id}/inspector`);
    $('labInspector').replaceChildren(...records.map(record => {
      const item = document.createElement('details'); item.className = 'lab-api-call';
      item.append(text('summary',`${record.method} · HTTP ${record.responseStatus} · ${record.durationMs} ms · ${record.success ? 'Success' : 'Failed'} · ${record.timestamp}`));
      item.append(text('p',`${record.actionId} · Request ${record.requestId} · ${record.endpoint}`));
      for (const [title,value] of [['Request',{query:record.query,payload:record.requestPayload,idempotencyKey:record.idempotencyKey}],['Response',record.responsePayload]]) {
        const part = document.createElement('details'); part.append(text('summary',title),text('pre',JSON.stringify(value,null,2)));
        const copy = text('button','Copy ' + title.toLowerCase(),'btn ghost');copy.type='button';
        copy.addEventListener('click',() => void navigator.clipboard.writeText(JSON.stringify(value,null,2)).then(() => {copy.textContent='Copied';}).catch(() => {copy.textContent='Copy unavailable';}));
        part.append(copy); item.append(part);
      }
      return item;
    }));
    $('labInspectorEmpty').hidden = records.length > 0;
  }
  async function confirmation(action) {
    const summary=describeLabAction(action);
    const card = text('div','', 'lab-action-card');card.append(text('strong',summary.title),text('p',summary.description),technicalDetails(action));
    $('labConversation').append(card);
    card.scrollIntoView({block:'nearest'});
    return new Promise(resolve => {
      const settle = confirmed => {cancelConfirmation=null;for (const button of card.querySelectorAll('button')) button.disabled=true;resolve(confirmed);};
      cancelConfirmation = () => settle(false);
      for (const [label,value] of [[summary.confirmLabel ?? 'Confirm',true],['Cancel',false]]) {
        const button=text('button',label,'btn outline');button.type='button';button.dataset.labConfirm=value ? 'yes' : 'no';button.addEventListener('click',() => settle(value));card.append(button);
      }
    });
  }
  async function send(prompt) {
    if (!session || session.state !== 'ready' || !controller || controllerSessionId !== session.id || working || emergencies.length) return;
    const actionController = controller;
    const active = session, sequence = ++turn;
    working = true; controls(); $('labMessage').value='';
    message('user',prompt);
    const prior = history.slice(-8);
    history.push({role:'user',content:prompt.slice(0,1000)});
    try {
      let result = await api(`/api/test-lab/sessions/${active.id}/chat`,{method:'POST',data:{message:prompt,history:prior}});
      for (let depth=0; depth<5; depth++) {
        if (sequence !== turn) return;
        message('assistant',result.reply); history.push({role:'assistant',content:result.reply.slice(0,1000)});history=history.slice(-8);
        $('labProviderMetadata').textContent = `${result.metadata.provider} / ${result.metadata.model} · ${result.metadata.latencyMs} ms · Request ${result.metadata.requestId ?? 'unavailable'}`;
        if (!result.action) break;
        const spec=actionController.definition(result.action.id);
        if (!spec) throw Error('This action is unavailable in the current test. Start a new Test Lab session to load the latest actions.');
        message('proposal',describeLabAction(result.action).description,result.action);
        const confirmed = !spec?.requiresConfirmation || await confirmation(result.action);
        if (sequence !== turn) return;
        const outcome = confirmed ? await actionController.dispatch(result.action,{requestId:result.actionRequestId,confirmed}) :
          {executed:false,result:{requestId:result.actionRequestId,action:result.action,status:'cancelled',message:'The user cancelled the action.'}};
        if (sequence !== turn) return;
        message('result',describeLabResult(result.action,outcome.result ?? {status:'error'}),outcome.result ?? {status:'error',reason:outcome.reason});
        if (!outcome.result) throw Error('Action could not be validated: ' + outcome.reason);
        if (depth === 4) throw Error('Action follow-up limit reached. Start a new message.');
        result = await api(`/api/test-lab/sessions/${active.id}/chat`,{method:'POST',data:{message:'Acknowledge this actual action result. Do not repeat the action.',history:history.slice(-8),actionResult:outcome.result}});
      }
    } catch (error) {if (sequence === turn) message('error',error.message);}
    finally {working=false;controls();await inspector().catch(() => {});}
  }
  $('openTestLab').addEventListener('click',() => {
    if (isBusy() || !eligibility) return;
    if (hasEdits() && !window.confirm('You have unsaved editor changes. Start Test Lab from the saved Worker source and keep your editor buffer unchanged? Cancel to return to editing.')) return;
    const project=getProject(), provider=['gemini','openai'].includes(project.provider) ? project.provider : 'gemini';
    $('labProvider').value=provider;$('labModel').value=provider === project.provider ? project.model : getModels()[provider];
    $('labKey').value='';$('labLaunchError').textContent='';launch.showModal();
  });
  $('labProvider').addEventListener('change',() => {$('labModel').value=getModels()[$('labProvider').value];});
  $('labLaunchCancel').addEventListener('click',() => { $('labKey').value='';launch.close(); });
  launch.addEventListener('close',() => {$('labKey').value='';});
  $('labLaunchForm').addEventListener('submit',async event => {
    event.preventDefault();if (launching) return;
    const project=getProject();
    const input={folder:project.folder,revision:project.revision,provider:$('labProvider').value,model:$('labModel').value,apiKey:$('labKey').value};
    $('labKey').value='';launching=true;launch.close();returnToManage();controls();
    try {
      const {job}=await api('/api/test-lab/start',{method:'POST',data:input}); input.apiKey='';
      await waitJob(job); await status();
    } catch (error) {message('error',error.message);$('labProgress').textContent=error.message;$('manageError').textContent=error.message;$('manageError').hidden=false;await status();}
    finally {input.apiKey='';launching=false;controls();}
  });
  $('labChatForm').addEventListener('submit',event => {event.preventDefault();const prompt=$('labMessage').value.trim();if(prompt) void send(prompt);});
  for (const suggestion of LAB_SUGGESTIONS) {
    const button=text('button','', 'lab-suggestion');button.type='button';button.dataset.labSuggestion=suggestion.id;
    button.append(text('span',suggestion.kind,'lab-suggestion-kind'),text('span',suggestion.label),text('span','↗','lab-suggestion-arrow'));
    button.title=suggestion.prompt;
    button.addEventListener('click',() => void send(suggestion.prompt));
    $('labSuggestions').append(button);
  }
  for (const button of panel.querySelectorAll('[data-lab-effect]')) button.addEventListener('click',() => playEffect(button.dataset.labEffect));
  $('labTargetText').addEventListener('input',() => {$('labPlaygroundStatus').textContent='Playground text box updated.';});
  $('labEnd').addEventListener('click',async () => {
    if (!session || launching || !window.confirm(`End Test and delete only Preview ${session.previewName}?`)) return;
    ++turn;cancelConfirmation?.();working=true;launching=true;controls();
    try {
      const {job}=await api(`/api/test-lab/sessions/${session.id}/end`,{method:'POST',data:{confirmation:session.previewName}});
      await waitJob(job); session=null;controller=null;controllerSessionId=null;history=[];$('labConversation').replaceChildren();$('labInspector').replaceChildren();$('labEffect').textContent='';$('labTargetText').value='';$('labPlaygroundStatus').textContent='';
      await status();
    } catch(error) {$('labProgress').textContent=error.message;await status();}
    finally {working=false;launching=false;controls();editorChanged();if (!session) await projectLoaded().catch(() => {});}
  });
  $('testLabReturn').addEventListener('click',returnToManage);
  window.addEventListener('beforeunload',event => {if(session || launching) {event.preventDefault();event.returnValue='';}});
  setInterval(() => {if (!document.hidden && !launching) void status().catch(() => {});},3000);
  return {projectLoaded,status,controls,get active(){return Boolean(session || launching);},
    allowNavigation(target) {return target === 'manage' || (!session && !launching) || window.confirm('A Test Lab Preview is still active. Leave this view while keeping the session running? Return to Test Lab and End Test to confirm cleanup.');},
    allowWorkerSwitch() {if(!session && !launching) return true;window.alert('End Test and confirm Preview cleanup before switching Workers.');return false;}};
}
