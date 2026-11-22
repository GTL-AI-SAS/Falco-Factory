/* Falco Factory Studio — local-only client. No third-party dependencies or storage. */
(() => {
  const $ = id => document.getElementById(id);
  const form = $('builderForm');
  const models = { mock: 'mock-v1', openai: 'gpt-5.4-mini', gemini: 'gemini-3.5-flash-lite' };
  let token = '';
  let lastAutoName = '';
  let userEditedName = false;
  let activeJobId = '';
  let activeJobMode = '';
  let pollHandle = null;
  let lastEventCount = -1;
  let jobArea = 'create';
  let activeJobProvider = 'mock';
  let managed = null;
  let staged = null;
  let remoteReview = null;
  let kvState = null;
  let compiledSections;
  let createSections;
  let actionTarget = '';
  let operationPoll = false;
  let projectRows = [];
  let remoteRows = [];
  let remoteAccount = '';
  let remoteSelected = null;
  let remoteFetching = false;
  let remoteFetchSerial = 0;
  let manageLoadSerial = 0;
  let chatWorker = null;
  let chatRequestSerial = 0;
  let manageChatSerial = 0;
  const enc = new TextEncoder();
  const byteLength = t => enc.encode(t).byteLength;
  const provider = () => form.querySelector('input[name="provider"]:checked').value;
  const knowledgeMode = () => form.querySelector('input[name="knowledgeMode"]:checked').value;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const successfulStatuses = ['ready', 'validated', 'generated', 'deployed', 'updated', 'restored', 'checked'];
  const eventStages = {
    prepare: 'Preflight', preflight: 'Preflight', generate: 'Build', backup: 'Snapshot',
    cloudflare: 'Cloudflare', kv: 'Knowledge KV', verify: 'Verification',
    done: 'Complete', warning: 'Attention', error: 'Error',
  };

  async function api(url, { method = 'GET', data } = {}) {
    const response = await fetch(url, { method, cache: 'no-store',
      headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-Falco-Local-Token': token } : {},
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (HTTP ${response.status})`);
    return result;
  }
  function slug(value) {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 53).replace(/-+$/,'');
  }
  function setError(msg) {
    $('formError').hidden = !msg;
    $('formError').textContent = msg || '';
    if (msg) $('formError').scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'nearest' });
  }
  function selectedProviderChanged() {
    const p = provider();
    document.querySelectorAll('.provider').forEach(card => card.classList.toggle('selected', card.dataset.provider === p));
    $('apiKeyArea').hidden = p === 'mock';
    $('mockReplyField').hidden = p !== 'mock';
    $('apiKeyLabel').textContent = p === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
    $('modelHelp').textContent = p === 'mock' ? 'Mock mode responds with a predefined greeting. No provider fees.' : 'Use a model identifier available to your provider account.';
    $('model').value = models[p];
    updateSummary(); updateActionVerificationOptions();
  }
  function updateSummary() {
    const business = $('business').value.trim();
    const name = $('name').value.trim();
    const p = provider();
    $('previewBusiness').textContent = business || 'Your business';
    $('previewMessage').textContent = p === 'mock' && $('mockReply').value.trim() ? $('mockReply').value.trim() : `¡Hola! Soy Falco${business ? ', el asistente de ' + business : ''}. ¿En qué puedo ayudarte?`;
    $('summaryName').textContent = name || '—';
    $('summaryProvider').textContent = p === 'mock' ? 'Mock · no costs' : p === 'openai' ? 'OpenAI · usage billed' : 'Gemini · usage billed';
    $('summaryModel').textContent = $('model').value.trim() || models[p];
    $('summaryOrigin').textContent = `${$('origin').value.split(/[\n,]/).map(x=>x.trim()).filter(Boolean).length} allowed`;
    const n = (byteLength($('faq').value) ? 1 : 0) + (byteLength($('instructions').value) ? 1 : 0);
    $('summaryKnowledge').textContent = n ? `${n} document${n > 1 ? 's' : ''} included` : 'No documents yet';
    const kv = knowledgeMode() === 'kv';
    $('summaryStorage').textContent = kv ? 'Cloudflare KV' : 'Embedded';
    for (const [key, limit] of [['faq',kv?96000:24000], ['instructions',kv?24000:12000]]) {
      const count = byteLength($(key).value);
      const el = $(`${key}Size`);
      el.textContent = `${(count / 1000).toFixed(count ? 1 : 0)} / ${limit / 1000} KB`;
      el.classList.toggle('over', count > limit);
    }
  }
  const GALLINAS_ACTION_PRESET = [{
    id: 'demo.open',
    description: 'Abrir una de las tres opciones visuales del sitio Gallinas y Valientes cuando el visitante lo solicite.',
    parameters: { option: { type:'string', enum:['01','02','03'] } }
  }];
  function readActionEditor(id) {
    const value = $(id).value.trim() || '[]';
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw Error('Client actions must be a valid JSON array.'); }
    if (!Array.isArray(parsed) || parsed.length > 8) throw Error('Use an array with at most 8 client actions.');
    if (byteLength(JSON.stringify(parsed)) > 3900) throw Error('Client actions exceed the Cloudflare binding limit (3.9 KB).');
    return parsed;
  }
  function updateActionVerificationOptions() {
    const update = (manifestId, areaId, checkId, helpId, supported) => {
      const area = $(areaId), checkbox = $(checkId), help = $(helpId);
      if (!area || !checkbox) return;
      let configured = false;
      try {
        const parsed = JSON.parse($(manifestId).value.trim() || '[]');
        configured = Array.isArray(parsed) && parsed.length > 0;
      } catch { configured = false; }
      area.hidden = !configured;
      checkbox.disabled = !configured || !supported;
      if (!configured || !supported) checkbox.checked = false;
      if (help && !supported) help.textContent = 'Action proposal tests require Gemini or OpenAI. Mock can still verify health, CORS and its fixed chat reply without provider charges.';
      else if (help) help.textContent = 'This authorizes one live AI request and also verifies the chat response. The first configured action and its first allowed parameter values are tested. Falco only returns the proposal; the website handler is never executed.';
    };
    update('actions', 'createActionCheckArea', 'createActionCheck', 'createActionCheckHelp', provider() !== 'mock');
    const managedProvider = $('managedProviderEdit')?.value ?? managed?.provider ?? 'mock';
    update('manageActions', 'manageActionCheckArea', 'manageActionCheck', 'manageActionCheckHelp', managedProvider !== 'mock');
  }
  function verificationSummary(verification = {}) {
    const keys = ['health', 'cors', 'chat', 'action', 'knowledge'];
    return keys.filter(key => Object.hasOwn(verification, key) || Object.hasOwn(verification, key + 'Status'))
      .map(key => {
        const raw = verification[key];
        const explicit = verification[key + 'Status'];
        const status = explicit || (raw === true ? 'pass' : raw === false ? 'failed' : 'skipped');
        const label = key === 'action' && verification.actionId ? `action (${verification.actionId})` : key;
        return { key, label, status, tone: status === 'pass' ? 'success' : status === 'failed' ? 'error' : status === 'not_configured' || status === 'skipped' ? 'info' : 'warning' };
      });
  }

  function config() {
    const actions = readActionEditor('actions');
    const checkAction = $('createActionCheck').checked;
    return {
      business: $('business').value.trim(), name: $('name').value.trim(),
      provider: provider(), model: $('model').value.trim(), origins: $('origin').value.split(/[\n,]/).map(x=>x.trim()).filter(Boolean),
      instructions: $('instructions').value, faq: $('faq').value, knowledgeMode: knowledgeMode(), actions,
      mockReply: $('mockReply').value.trim(),
      rateLimit: $('rateLimit').value.trim(), outputFolder: $('outputFolder').value.trim(),
      accountId: $('accountId').value.trim(), force: $('force').checked,
      confirmName: $('confirmName').value.trim(),
      clearFaq: $('force').checked && $('clearFaq').checked,
      clearInstructions: $('force').checked && $('clearInstructions').checked, clearKnowledge: $('clearKnowledge').value.trim(),
      checkProvider: $('createProviderCheck').checked, checkAction,
      actionMessage: checkAction ? $('createActionMessage').value.trim() : '',
      ...(createSections ? { sections: createSections } : {}),
    };
  }
  function assertLocalConfig() {
    const d = config();
    if (!d.business || d.business.length < 2) throw new Error('Enter a business name (at least 2 characters).');
    if (!/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(d.name)) throw new Error('Worker name must be 3–63 characters, lowercase letters, numbers or hyphens.');
    if (d.force && d.confirmName !== d.name) throw new Error('To allow replacement, type the exact Worker name in Advanced configuration.');
    if (byteLength(d.faq) > (d.knowledgeMode==='kv'?96000:24000) || byteLength(d.instructions) > (d.knowledgeMode==='kv'?24000:12000)) throw new Error('A knowledge document exceeds its size limit.');
    if (d.checkAction && (!d.actions.length || d.actionMessage.length < 3 || d.actionMessage.length > 500)) throw new Error('Configure a Client Action and enter a test message of 3–500 characters.');
    return d;
  }
  function clearConsole() {
    $('consoleBody').replaceChildren();
    $('resultLinks').hidden = true;
    $('testChat').hidden = true;
  }
  function logLine(message, kind = 'info', target = 'consoleBody', event) {
    const row = document.createElement('div');
    row.className = `console-line ${kind}`;
    const mark = document.createElement('span');
    mark.className = 'event-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = kind === 'success' ? '✓' : kind === 'error' ? '×' : kind === 'warning' ? '!' : '›';
    const content = document.createElement('div');
    if (event) {
      const meta = document.createElement('div');
      meta.className = 'event-meta';
      const stage = document.createElement('strong');
      stage.textContent = eventStages[event.stage] || event.stage;
      meta.append(stage);
      if (event.at) {
        const time = document.createElement('time');
        time.dateTime = event.at;
        time.textContent = new Date(event.at).toLocaleTimeString();
        meta.append(time);
      }
      content.append(meta);
    }
    content.append(document.createTextNode(message));
    row.append(mark, content);
    $(target).appendChild(row);
    $(target).scrollTop = $(target).scrollHeight;
  }
  function consoleStatus(text, id = 'consoleStatus', state = text.toLowerCase()) {
    const status = $(id);
    status.textContent = text;
    if (text.endsWith('CHECKS PENDING') || ['partial', 'cancelled', 'interrupted'].includes(state)) status.dataset.tone = 'warning';
    else if (successfulStatuses.includes(state)) status.dataset.tone = 'success';
    else if (['failed', 'error'].includes(state)) status.dataset.tone = 'error';
    else status.dataset.tone = 'running';
  }
  function revealLog(id) {
    const log = $(id);
    log.open = true;
    const { top, bottom } = log.getBoundingClientRect();
    if (top < $('workspaceHeader').offsetHeight || bottom > window.innerHeight) {
      log.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'nearest' });
    }
  }
  function busy(value) {
    for (const id of ['previewBtn','generateBtn','deployBtn']) $(id).disabled = value;
  }
  async function runPreview() {
    setError('');
    try {
      const d = assertLocalConfig();
      busy(true);
      const result = await api('/api/preview', { method: 'POST', data: d });
      clearConsole();
      logLine('Configuration validated', 'success');
      logLine(`Worker: ${result.name}`);
      logLine(`${result.files.length} managed files in the project`);
      if (result.diff) {
        logLine('Changed files: ' + (result.diff.files.join(', ') || 'none'));
        logLine('FAQ: ' + result.diff.faq.removedLines + ' removed / ' + result.diff.faq.addedLines + ' added lines. Instructions: ' + result.diff.instructions.removedLines + ' removed / ' + result.diff.instructions.addedLines + ' added lines.');
        logLine('Configuration changes: ' + [...result.diff.settings, ...(result.diff.originsChanged ? ['origins'] : []), ...(result.diff.actionsChanged ? ['actions'] : [])].join(', '));
      }
      logLine(result.localExists ? 'Local project exists — replacement confirmation needed.' : 'Local project name available.', result.localExists ? 'warning' : 'success');
      logLine('Preview only. No files written or Cloudflare changes.', 'muted');
      consoleStatus('VALIDATED');
      revealLog('consoleCard');
    } catch (err) { setError(err.message); consoleStatus('ERROR'); }
    finally { busy(false); }
  }
  async function runBuild(mode) {
    setError('');
    try {
      const d = assertLocalConfig();
      if (mode === 'deploy' && d.provider !== 'mock' && !$('apiKey').value.trim()) {
        const answer = window.confirm('No API key is entered in the Studio. If FALCO_PROVIDER_API_KEY is not configured on this computer, deployment will be blocked. Continue?');
        if (!answer) return;
      }
      if (d.force) {
        const preview = await api('/api/preview', { method: 'POST', data: d });
        if (preview.diff && !window.confirm('Replace managed files with a backup?\n\n' + diffText(preview.diff))) return;
      }
      if (mode === 'deploy' && !window.confirm(`Deploy ${d.name} to your Cloudflare account?\n\n${d.force ? 'WARNING: you authorized replacement of an existing Worker.' : 'Existing Workers will not be overwritten.'}`)) return;
      busy(true);
      clearConsole();
      consoleStatus('STARTING');
      logLine(`Starting ${mode === 'deploy' ? 'Cloudflare deployment' : 'local generation'}...`);
      revealLog('consoleCard');
      const payload = { ...d, mode, ...(mode === 'deploy' ? { apiKey: $('apiKey').value.trim() } : {}) };
      const result = await api('/api/jobs', { method: 'POST', data: payload });
      // Never retain a provider key in the UI after it has been submitted.
      $('apiKey').value = '';
      activeJobId = result.job.id;
      $('cancelCreateJob').hidden = false;
      jobArea = 'create';
      activeJobProvider = d.provider;
      activeJobMode = mode;
      lastEventCount = -1;
      void updateJob();
      pollHandle = window.setInterval(updateJob, 750);
    } catch (err) {
      setError(err.message);
      logLine(err.message, 'error');
      consoleStatus('FAILED');
      busy(false);
    }
  }
  function setManageError(message) {
    $('manageError').hidden = !message;
    $('manageError').textContent = message || '';
  }
  function switchMode(target) {
    const isManage = target === 'manage';
    $('createView').hidden = isManage;
    $('manageView').hidden = !isManage;
    $('createNav').classList.toggle('active', !isManage);
    $('manageNav').classList.toggle('active', isManage);
    $('createNav').setAttribute('aria-selected', String(!isManage));
    $('manageNav').setAttribute('aria-selected', String(isManage));
    $('createNav').tabIndex = isManage ? -1 : 0;
    $('manageNav').tabIndex = isManage ? 0 : -1;
    $('sidebarCreate').classList.toggle('active', !isManage);
    $('sidebarManage').classList.toggle('active', isManage);
    $(isManage ? 'sidebarCreate' : 'sidebarManage').removeAttribute('aria-current');
    $(isManage ? 'sidebarManage' : 'sidebarCreate').setAttribute('aria-current', 'page');
    $('workspaceMode').textContent = isManage ? 'Manage Workers' : 'Create new';
    setSidebar(false);
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'instant' : 'smooth' });
    if (isManage && !remoteFetching) void refreshRemoteWorkers();
  }
  function setSidebar(open) {
    $('toggleSidebar').setAttribute('aria-expanded', String(open));
    $('sidebarContent').classList.toggle('sidebar-open', open);
  }
  function cloudStatus(message, { error = false } = {}) {
    $('remoteWorkerStatus').textContent = message;
    $('remoteWorkerStatus').classList.toggle('error', error);
  }
  function renderRemoteWorkers() {
    const list = $('remoteWorkerList');
    list.replaceChildren();
    const query = $('workerSearch').value.trim().toLowerCase();
    const rows = remoteRows.filter(item => [item.name, item.business].some(value => value?.toLowerCase().includes(query)));
    $('remoteWorkerCount').textContent = String(rows.length);
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'remote-empty';
      empty.textContent = query ? 'No Workers match your search.' : 'No Worker scripts found in this Cloudflare account.';
      list.append(empty); return;
    }
    for (const item of rows) {
      const card = document.createElement('div');
      card.className = 'remote-worker-card';
      const glyph = document.createElement('span'); glyph.className = 'remote-glyph'; glyph.textContent = '↗︎';
      const info = document.createElement('div'); info.className = 'remote-worker-detail';
      const title = document.createElement('strong'); title.textContent = item.name;
      const subtitle = document.createElement('small');
      subtitle.textContent = item.source === 'linked'
        ? `${item.business || 'Falco'} · ${item.provider || 'Worker'} · local source linked`
        : item.source === 'account-mismatch' ? 'Local source found, but it belongs to another Cloudflare account'
        : 'Deployed on Cloudflare · local source not linked';
      info.append(title, subtitle);
      if (item.modifiedOn) { const date = document.createElement('small'); date.textContent = 'Last Cloudflare change ' + item.modifiedOn.slice(0, 10); info.append(date); }
      const actions = document.createElement('div'); actions.className = 'remote-worker-actions';
      const badge = document.createElement('span'); badge.className = 'remote-worker-badge ' + (item.editable ? 'linked' : 'remote-only');
      badge.textContent = item.editable ? 'EDITABLE' : item.source === 'account-mismatch' ? 'ACCOUNT MISMATCH' : 'REMOTE ONLY';
      const buttonRow = document.createElement('div'); buttonRow.className = 'remote-button-row';
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'remote-load';
      btn.textContent = 'Load Worker ↗︎';
      btn.title = 'Open knowledge editor and automatically find an older Falco source';
      btn.addEventListener('click', () => void loadRemoteWorker(item, btn));
      const chat = document.createElement('button'); chat.type = 'button'; chat.className = 'remote-chat';
      chat.textContent = 'Test chat →';
      chat.title = 'Chat with this deployed Falco';
      chat.addEventListener('click', () => openWorkerChat(item));
      const kit = document.createElement('button'); kit.type = 'button'; kit.className = 'remote-export';
      kit.textContent = 'Export frontend kit ↓';
      kit.title = 'Download neutral HTML/CSS/JS integration ZIP for your website agent';
      kit.addEventListener('click', () => void exportFrontendKit(item, kit));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remote-delete';
      remove.textContent = 'Delete';
      remove.title = 'Permanently delete this Worker on Cloudflare';
      remove.addEventListener('click', () => void deleteRemoteWorker(item, remove));
      buttonRow.append(chat,btn,kit,remove);
      actions.append(badge, buttonRow); card.append(glyph, info, actions); list.append(card);
    }
  }
  async function exportFrontendKit(item, button) {
    if (!item || !item.accountId || !item.name) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Preparing ZIP…';
    setManageError('');
    cloudStatus(`Preparing neutral frontend kit for ${item.name}…`);
    try {
      const resp = await fetch('/api/frontend-kit/export', {
        method:'POST', cache:'no-store',
        headers:{ 'Content-Type':'application/json', 'X-Falco-Local-Token': token },
        body: JSON.stringify({ accountId: item.accountId, name: item.name,
          customDomain: $('kitDomain').value.trim(), siteOrigin: $('kitSite').value.trim(),
          privacy: { url: $('kitPrivacyUrl').value.trim(), notice: $('kitPrivacyNotice').value.trim() } }),
      });
      if (!resp.ok) {
        const problem = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error(problem.error || `Export failed (HTTP ${resp.status}).`);
      }
      const blob = await resp.blob();
      if (!blob.size || !resp.headers.get('content-type')?.includes('application/zip')) throw new Error('Invalid ZIP response.');
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `${item.name}-frontend-kit.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
      cloudStatus(`${item.name}: frontend kit downloaded. Give the ZIP to your website agent. No Cloudflare changes were made.`);
    } catch(err) {
      setManageError(err.message);
      cloudStatus(err.message, { error:true });
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }
  async function loadRemoteWorker(item, button) {
    if (pollHandle) { setManageError('Finish the ongoing deployment before loading another Worker.'); return; }
    if (managed && currentManageChanges().changed && !window.confirm('Discard unsaved edits before loading a different Worker?')) return;
    button.disabled = true;
    const previousLabel = button.textContent;
    button.textContent = 'Loading…';
    setManageError('');
    try {
      const data = await api('/api/cloudflare/workers/load', { method:'POST', data:{ accountId:item.accountId, name:item.name }});
      await loadProjects();
      await loadManagedProject(data.folder, { force:true });
      if (managed?.name !== item.name) throw new Error('Loaded project does not match the selected Worker.');
      await refreshRemoteWorkers();
      cloudStatus(`${item.name} loaded with its deployed configuration and knowledge. No redeployment happened.`);
      $('manageEditorPanel').scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' });
    } catch (err) {
      // If the original source is not on disk, keep the Worker remote-only.
      await selectRemoteWorker(item);
      setManageError(err.message);
    } finally {
      button.disabled = false;
      button.textContent = previousLabel;
    }
  }
  async function deleteRemoteWorker(item, button) {
    if (pollHandle) { setManageError('Finish the ongoing deployment first.'); return; }
    if (managed && currentManageChanges().changed && !window.confirm('You have unsaved knowledge changes. Continue to deletion?')) return;
    const typed = window.prompt(`PERMANENT DELETE on Cloudflare\n\nWorker: ${item.name}\nAccount: ${item.accountId.slice(0,6)}…${item.accountId.slice(-4)}\n\nThis removes the remote Worker and its URL. The local project will be kept.\n\nType the EXACT Worker name to continue:`);
    if (typed === null) return;
    if (typed !== item.name) { setManageError('Worker name did not match. Nothing was deleted.'); return; }
    if (!window.confirm(`LAST CONFIRMATION\n\nDelete ${item.name} from Cloudflare permanently?\n\nThis cannot be undone by Falco Studio.`)) return;
    button.disabled = true;
    button.textContent = 'Deleting…';
    setManageError('');
    try {
      const result = await api('/api/cloudflare/workers/delete', { method:'POST', data:{ accountId:item.accountId, name:item.name, confirmation:typed, acknowledge:'DELETE' }});
      if (!result.deleted || result.name !== item.name) throw new Error('Deletion was not confirmed by Cloudflare. Refresh to check.');
      if (managed?.name === item.name) {
        managed = null;
        ++manageChatSerial;
        $('manageLiveLinks').hidden = true;
        $('manageTestChat').hidden = true;
        $('manageProject').value = '';
        $('manageEditorPanel').hidden = true;
        $('manageProjectInfo').hidden = true;
        $('historyList').replaceChildren();
        $('manageIdentityName').textContent = 'Choose a Falco';
        $('manageIdentitySub').textContent = 'Worker deleted remotely; local source retained.';
      }
      remoteSelected = null;
      $('remoteSelection').hidden = true;
      await refreshRemoteWorkers();
      cloudStatus(`${item.name} deleted from Cloudflare. Local files remain for recovery.`);
    } catch (err) { setManageError(err.message); }
    finally { button.disabled = false; button.textContent = 'Delete'; }
  }

  async function selectRemoteWorker(item) {
    if (item.editable && item.folder) {
      remoteSelected = null;
      $('remoteSelection').hidden = true;
      await loadManagedProject(item.folder);
      if (managed?.folder === item.folder) $('manageEditorPanel').scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' });
      return;
    }
    if (managed && currentManageChanges().changed && !window.confirm('Discard your unsaved knowledge edits before selecting a different Worker?')) return;
    managed = null;
    ++manageChatSerial;
    $('manageLiveLinks').hidden = true;
    $('manageTestChat').hidden = true;
    $('manageProject').value = '';
    $('manageEditorPanel').hidden = true;
    $('manageProjectInfo').hidden = true;
    $('historyList').replaceChildren();
    $('manageIdentityName').textContent = item.name;
    $('manageIdentitySub').textContent = 'Cloudflare remote · not linked to this Studio';
    updateManageDiff();
    remoteSelected = { name: item.name, accountId: item.accountId };
    $('remoteSelection').hidden = false;
    $('remoteSelectedName').textContent = item.name;
    $('remoteSelectedMessage').textContent = item.source === 'account-mismatch'
      ? 'A local project with this name targets a different account. Studio will refuse an unsafe link.'
      : 'Found on Cloudflare. To edit FAQs and instructions, link the original local Factory source (no redeployment).';
    $('linkTargetMessage').textContent = `Linking Cloudflare Worker: ${item.name}`;
    $('linkTargetMessage').hidden = false;
    $('remoteSelection').scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'nearest' });
  }
  async function refreshRemoteWorkers() {
    const requestId = ++remoteFetchSerial;
    remoteFetching = true;
    $('refreshCloudWorkers').disabled = true;
    cloudStatus('Contacting your Cloudflare account...');
    try {
      const manual = $('remoteAccountManual').value.trim();
      const requested = manual || $('remoteAccountSelect').value;
      if (requested && !/^[a-f0-9]{32}$/i.test(requested)) throw new Error('Cloudflare Account ID must be 32 hexadecimal characters.');
      const query = requested ? `?accountId=${encodeURIComponent(requested)}` : '';
      const data = await api(`/api/cloudflare/workers${query}`);
      if (requestId !== remoteFetchSerial) return;
      remoteRows = data.workers;
      remoteAccount = data.accountId;
      cloudStatus(`${remoteRows.length} deployed Worker${remoteRows.length===1?'':'s'} found · account ${remoteAccount.slice(0,6)}…${remoteAccount.slice(-4)} · refreshed ${new Date(data.checkedAt).toLocaleTimeString()}`);
      renderRemoteWorkers();
    } catch (err) {
      if (requestId !== remoteFetchSerial) return;
      remoteRows = [];
      $('remoteWorkerCount').textContent = '—';
      $('remoteWorkerList').replaceChildren();
      const warning = document.createElement('div'); warning.className = 'remote-empty';
      warning.textContent = 'Cloudflare Worker list unavailable. Local Falco projects are still accessible below.';
      $('remoteWorkerList').append(warning);
      cloudStatus(err.message + ' · Check Wrangler login, Account ID and Workers read permissions.', {error:true});
    } finally {
      if (requestId === remoteFetchSerial) { remoteFetching = false; $('refreshCloudWorkers').disabled = false; }
    }
  }
  function populateCloudAccounts(status) {
    const select = $('remoteAccountSelect');
    const chosen = select.value;
    select.replaceChildren();
    const option = document.createElement('option'); option.value = ''; option.textContent = 'Automatic account selection'; select.append(option);
    const accounts = status.accounts || [];
    for (const account of accounts) {
      const el = document.createElement('option'); el.value = account.id;
      el.textContent = `${account.name} · ${account.id.slice(0,6)}…${account.id.slice(-4)}`;
      select.append(el);
    }
    if (chosen && accounts.some(a=>a.id===chosen)) select.value = chosen;
    else if (status.selectedAccount && accounts.some(a=>a.id===status.selectedAccount)) select.value = status.selectedAccount;
    else if (accounts.length === 1) select.value = accounts[0].id;
  }
  function currentManageChanges() {
    if (!managed) return { changed: false, faqChanged: false, instructionsChanged: false, originsChanged: false, actionsChanged: false };
    const faqChanged = $('manageFaq').value !== managed.faq;
    const instructionsChanged = $('manageInstructions').value !== managed.instructions;
    const originalOrigins = managed.origins ?? [managed.origin];
    const editedOrigins = $('manageOrigins').value.split(/[\n,]/).map(s=>s.trim()).filter(Boolean);
    const originsChanged = JSON.stringify(editedOrigins) !== JSON.stringify(originalOrigins);
    let actionsChanged=false, actionsInvalid=false;
    try { actionsChanged = JSON.stringify(readActionEditor('manageActions')) !== JSON.stringify(managed.actions ?? []); } catch { actionsInvalid=true; }
    return { faqChanged, instructionsChanged, originsChanged, actionsChanged, actionsInvalid, changed: faqChanged || instructionsChanged || originsChanged || actionsChanged };
  }
  function changedLines(a,b) {
    const before = a.split(/\r?\n/), after = b.split(/\r?\n/);
    const old = new Map(), next = new Map();
    for (const line of before) old.set(line, (old.get(line)||0)+1);
    for (const line of after) next.set(line, (next.get(line)||0)+1);
    let added=0, removed=0;
    for (const [line,n] of next) added += Math.max(0,n-(old.get(line)||0));
    for (const [line,n] of old) removed += Math.max(0,n-(next.get(line)||0));
    return { added, removed };
  }
  function updateManageDiff() {
    const changes = currentManageChanges();
    for (const [key, changed] of [['Faq',changes.faqChanged],['Instructions',changes.instructionsChanged],['Origins',changes.originsChanged],['Actions',changes.actionsChanged]]) {
      const chip = $(key === 'Faq' ? 'faqChange' : key === 'Origins' ? 'originsChange' : key === 'Actions' ? 'actionsChange' : 'instructionsChange');
      chip.textContent = changed ? 'MODIFIED' : 'UNCHANGED';
      chip.classList.toggle('modified', changed);
    }
    const limits = [['manageFaq', managed?.knowledgeMode==='kv'?96000:24000],['manageInstructions', managed?.knowledgeMode==='kv'?24000:12000]];
    let invalid = changes.actionsInvalid;
    for (const [id,max] of limits) {
      const size = byteLength($(id).value);
      const counter = $(id+'Size');
      counter.textContent = `${(size/1000).toFixed(1)} / ${max/1000} KB`;
      counter.classList.toggle('over', size > max);
      invalid ||= size > max;
    }
    const originRows = $('manageOrigins').value.split(/[\n,]/).map(s=>s.trim()).filter(Boolean);
    invalid ||= !originRows.length || originRows.length > 20 || originRows.some(x => !/^https?:\/\/[^/?#\s]+$/.test(x));
    $('saveDeploy').disabled = (!changes.changed && !compiledSections) || invalid || !managed || Boolean(pollHandle);
    $('manageChangeHeadline').textContent = invalid ? 'Check origins, JSON and document limits' : changes.changed ? 'Changes ready to review' : 'Everything is up to date';
    $('manageChangeDetail').textContent = invalid ? 'Correct the invalid origins, client actions JSON or oversized document.' : changes.changed ? 'A version backup will be created before publishing the update.' : 'Make an edit to preview what will be deployed.';
    const diff = $('manageDiff');
    diff.replaceChildren();
    diff.hidden = !changes.changed;
    if (managed && changes.changed) {
      for (const [title, original, updated] of [['FAQ', managed.faq, $('manageFaq').value],['Instructions',managed.instructions,$('manageInstructions').value],['Allowed origins',(managed.origins ?? [managed.origin]).join('\n'),$('manageOrigins').value],['Client actions',JSON.stringify(managed.actions ?? [],null,2),$('manageActions').value]]) {
        if (original === updated) continue;
        const d = changedLines(original, updated);
        const row = document.createElement('div'); row.className = 'diff-line';
        const caption = document.createElement('strong'); caption.textContent = title;
        const counts = document.createElement('span'); counts.textContent = `+${d.added} / −${d.removed} lines`;
        row.append(caption, counts); diff.appendChild(row);
      }
    }
  }
  async function loadVersions() {
    const list = $('historyList'); list.replaceChildren();
    if (!managed) return;
    try {
      const { versions } = await api(`/api/projects/${encodeURIComponent(managed.folder)}/versions`);
      if (!versions.length) {
        const row = document.createElement('div'); row.className = 'history-empty';
        row.textContent = 'No snapshots yet. Your first update will automatically save the current knowledge.';
        list.appendChild(row); return;
      }
      for (const entry of versions) {
        const row = document.createElement('div'); row.className = 'history-entry';
        const detail = document.createElement('div'); detail.className = 'history-info';
        const when = document.createElement('strong'); when.textContent = new Date(entry.createdAt).toLocaleString();
        const meta = document.createElement('small'); meta.textContent = `${entry.reason.replaceAll('_',' ')} · ${entry.id.slice(0,8)}`;
        detail.append(when,meta);
        const button = document.createElement('button'); button.type='button'; button.className='restore-button'; button.textContent='Restore knowledge';
        button.addEventListener('click', () => void startManageJob('restore',entry.id));
        const full = document.createElement('button'); full.type = 'button'; full.className = 'restore-button'; full.textContent = 'Restore full configuration';
        full.addEventListener('click', () => void startManageJob('restore-config', entry.id));
        const controls = document.createElement('div');
        controls.className = 'history-controls';
        controls.append(button, full);
        row.append(detail, controls); list.appendChild(row);
      }
    } catch (err) { const row=document.createElement('div'); row.className='history-empty'; row.textContent=err.message; list.append(row); }
  }
  async function loadManagedProject(folder, { force = false } = {}) {
    if (!folder) {
      ++manageLoadSerial;
      ++manageChatSerial;
      managed = null;
      for (const id of ['manageEditorPanel', 'manageProjectInfo', 'manageEditLink', 'manageOpsLink', 'manageLiveLinks', 'manageTestChat']) $(id).hidden = true;
      $('manageIdentityName').textContent = 'Choose a Falco';
      $('manageIdentitySub').textContent = 'Load a deployment or select a linked project.';
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'No project selected.';
      $('historyList').replaceChildren(empty);
      updateManageDiff();
      return;
    }
    if (!force && managed && currentManageChanges().changed && !window.confirm('Discard your unsaved knowledge edits?')) {
      $('manageProject').value = managed.folder; return;
    }
    const requestId = ++manageLoadSerial;
    ++manageChatSerial;
    managed = null;
    for (const id of ['manageEditorPanel', 'manageProjectInfo', 'manageEditLink', 'manageOpsLink']) $(id).hidden = true;
    updateManageDiff();
    setManageError('');
    $('manageLiveLinks').hidden = true;
    $('manageTestChat').hidden = true;
    try {
      const route = `/api/projects/${encodeURIComponent(folder)}`;
      const local = await api(route);
      if (requestId !== manageLoadSerial) return;
      const { project } = local.project.accountId
        ? await api(route + '/refresh', { method: 'POST', data: {} }) : local;
      if (requestId !== manageLoadSerial) return;
      managed = project;
      initializeOperations(project);
      $('manageTestReply').textContent = '';
      $('manageTestSend').disabled = false;
      $('manageTestChat').hidden = !project.accountId;
      remoteSelected = null;
      $('remoteSelection').hidden = true;
      $('linkTargetMessage').hidden = true;
      $('manageProject').value = folder;
      for (const id of ['manageEditorPanel', 'manageProjectInfo', 'manageEditLink', 'manageOpsLink']) $(id).hidden = false;
      $('manageFaq').value = project.faq;
      $('manageInstructions').value = project.instructions;
      $('manageOrigins').value = (project.origins ?? [project.origin]).join('\n');
      $('manageActions').value = JSON.stringify(project.actions ?? [], null, 2);
      updateActionVerificationOptions();
      $('manageKnowledgeMode').textContent = project.knowledgeMode === 'kv' ? 'Cloudflare KV' : 'Embedded';
      $('manageStorageCard').dataset.storage = project.knowledgeMode;
      $('manageKnowledgeInfo').textContent = project.knowledgeMode === 'kv'
        ? 'Knowledge changes publish to KV without redeploying the Worker. Cloudflare propagation is eventual; existing AI secrets remain unchanged.'
        : 'Business knowledge is bundled with the Worker. Enable KV only if you need independently published knowledge; this migration creates an isolated Cloudflare namespace.';
      $('enableKvKnowledge').hidden = project.knowledgeMode === 'kv';
      $('republishKvKnowledge').hidden = project.knowledgeMode !== 'kv';
      $('managedBusiness').textContent = project.business;
      $('managedWorker').textContent = project.name;
      $('managedProvider').textContent = `${project.provider} · ${project.model}`;
      $('managedAccount').textContent = project.accountId ? project.accountId.slice(0,6)+'…'+project.accountId.slice(-4) : 'Not set';
      $('manageIdentityName').textContent = project.name;
      $('manageIdentitySub').textContent = `${project.business} · ${project.provider}`;
      updateManageDiff();
      if (project.accountId) void reviewRemote().catch(error => { if (managed === project) setManageError(error.message); });
      $('upgradeDiagnostics').disabled = true;
      $('runtimeUpgradeStatus').textContent = 'Checking runtime files…';
      try {
        const info = await api(`/api/projects/${encodeURIComponent(folder)}/runtime-status`);
        if (requestId !== manageLoadSerial) return;
        $('runtimeUpgradeStatus').textContent = info.state === 'current' ? 'Current Falco runtime installed. Redeploy to verify or recover Cloudflare.' : info.state === 'upgrade_available' ? `${info.files.length} official source files can be upgraded safely. Existing API key preserved.` : (info.message || 'Manual source review required.');
        $('upgradeDiagnostics').disabled = !['upgrade_available','current'].includes(info.state);
        $('upgradeDiagnostics').textContent = info.state === 'current' ? 'Redeploy & verify runtime ↗︎' : 'Upgrade runtime & deploy ↗︎';
      } catch (err) {
        if (requestId !== manageLoadSerial) return;
        $('runtimeUpgradeStatus').textContent = err.message;
      }
      await loadVersions();
    } catch (err) {
      if (requestId !== manageLoadSerial) return;
      managed=null;
      setManageError('Could not load the deployed configuration. ' + err.message);
    }
  }
  async function loadProjects() {
    try {
      const { projects } = await api('/api/projects');
      projectRows = projects;
      $('projectCount').textContent = projects.length;
      if (remoteRows.length && remoteAccount) {
        remoteRows = remoteRows.map(item => {
          const project = projects.find(p => p.name === item.name && p.accountId?.toLowerCase() === remoteAccount.toLowerCase());
          return project ? { ...item, source:'linked', editable:true, folder:project.folder, business:project.business, provider:project.provider } : item;
        });
        renderRemoteWorkers();
      }
      const list = $('projectList'); list.replaceChildren();
      const select = $('manageProject'); const chosen = select.value;
      select.replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value=''; placeholder.textContent='Select an existing Falco...'; select.append(placeholder);
      if (!projects.length) {
        const empty = document.createElement('div'); empty.className = 'project-empty';
        empty.textContent = 'No projects yet. Create or import a Falco.'; list.append(empty);
      }
      for (const project of projects) {
        const option = document.createElement('option'); option.value=project.folder;
        option.textContent=`${project.business} · ${project.name}`; select.append(option);
        const item = document.createElement('button'); item.type='button'; item.className='project-item project-click';
        const icon = document.createElement('span'); icon.className='project-icon'; icon.textContent='F';
        const info = document.createElement('div'); info.className='project-text';
        const name = document.createElement('strong'); name.textContent=project.name;
        const sub = document.createElement('small'); sub.textContent=project.provider+' · manage →';
        info.append(name,sub); item.append(icon,info);
        item.addEventListener('click', () => { switchMode('manage'); void loadManagedProject(project.folder); });
        list.append(item);
      }
      if (projects.some(p=>p.folder===chosen)) select.value=chosen;
      else if (managed && projects.some(p=>p.folder===managed.folder)) select.value=managed.folder;
    } catch { /* UI remains usable without project listing */ }
  }
  function projectRoute(suffix) { return '/api/projects/' + encodeURIComponent(managed.folder) + '/' + suffix; }

  function diffText(diff) {
    const labels = ['faq', 'instructions'].filter(key => diff[key]?.changed).map(key => `${key}: +${diff[key].addedLines} / −${diff[key].removedLines} lines`);
    if (diff.originsChanged) labels.push('Allowed origins: ' + diff.previousOrigins.join(', ') + ' → ' + diff.origins.join(', '));
    if (diff.actionsChanged) labels.push('Client actions: ' + JSON.stringify(diff.previousActions) + ' → ' + JSON.stringify(diff.actions));
    for (const setting of diff.settings ?? []) labels.push(typeof setting === 'string' ? setting : `${setting.field}: ${JSON.stringify(setting.before)} → ${JSON.stringify(setting.after)}`);
    if (diff.files?.length) labels.push('Files: ' + diff.files.join(', '));
    return labels.join('\n') || 'Knowledge and managed settings already match.';
  }

  function manageEdits() {
    const fields = { faq: $('manageFaq').value, instructions: $('manageInstructions').value,
      origins: $('manageOrigins').value.split(/[\n,]/).map(value => value.trim()).filter(Boolean), actions: readActionEditor('manageActions') };
    if (compiledSections) fields.sections = compiledSections;
    return fields;
  }

  async function startManageJob(operation, versionId = '', extra = {}) {
    if (!managed || pollHandle || operationPoll) return;
    operationPoll = true;
    setManageError('');
    try {
      const project = managed;
      const changes = currentManageChanges();
      const restore = ['restore', 'restore-config'].includes(operation);
      const full = operation === 'restore-config';
      const editorOperation = operation === 'update' || operation === 'stage';
      if (operation === 'update' && !changes.changed && !compiledSections) return;
      if (!editorOperation && changes.changed && !window.confirm('Continue with the saved project and discard the unsaved editor changes?')) return;
      const actionCheckAllowed = ['update','check-provider','upgrade-runtime','enable-kv','publish-kv','restore','restore-config','settings','replace-secret'].includes(operation);
      const checkAction = actionCheckAllowed && $('manageActionCheck').checked;
      const actionMessage = checkAction ? $('manageActionMessage').value.trim() : '';
      if (checkAction && actionMessage.length < 3) throw new Error('Enter a test message of at least 3 characters for the first configured Client Action.');
      const payload = { mode: operation, folder: project.folder, revision: project.revision, versionId,
        checkProvider: project.provider === 'mock' || $('manageProviderCheck').checked || checkAction,
        checkAction, ...(checkAction ? { actionMessage } : {}), ...extra };
      if (editorOperation) Object.assign(payload, manageEdits());
      if (restore) {
        const { diff } = await api(projectRoute('restore-preview'), { method: 'POST', data: { revision: project.revision, versionId, full } });
        if (!window.confirm(`Restore ${full ? 'full configuration' : 'knowledge'} for ${project.name}?\n\n${diffText(diff)}`)) return;
        if (full) payload.acknowledge = 'RESTORE CONFIG';
      }
      if (['restore-config','settings','replace-secret','kv-rollback','stage','promote','rollback'].includes(operation)) {
        const scope = operation === 'rollback' ? 'Cloudflare version rollback (KV is separate)' : operation.replaceAll('-', ' ');
        const typed = window.prompt(`Type the exact Worker name to confirm ${scope} for ${project.name}.`);
        if (typed !== project.name) return;
        payload.confirmName = typed;
      }
      if (operation === 'enable-kv' && !window.confirm('Provision a separate Cloudflare KV namespace and move this Worker’s current knowledge to it?')) return;
      if (operation === 'upgrade-runtime' && !window.confirm('Back up and deploy the current official Falco runtime?')) return;
      if (operation === 'publish-kv' && !window.confirm('Republish the saved KV knowledge and verify the current Worker deployment?')) return;
      if (operation === 'update' && !window.confirm('Back up and publish the changes to ' + project.name + '?')) return;
      if (operation === 'check-provider' && !payload.checkProvider) throw new Error('Authorize one live provider request first.');
      const response = await api('/api/jobs', { method: 'POST', data: payload });
      jobArea = 'manage'; activeJobId = response.job.id; lastEventCount = -1;
      activeJobProvider = payload.provider ?? project.provider;
      $('managedKeyEdit').value = '';
      $('cancelManageJob').hidden = false;
      $('manageConsoleBody').replaceChildren();
      consoleStatus('STARTING', 'manageConsoleStatus');
      revealLog('manageConsole');
      $('saveDeploy').disabled = true;
      pollHandle = window.setInterval(updateJob, 750);
      void updateJob();
    } catch (error) { setManageError(error.message); }
    finally { operationPoll = false; }
  }

  function renderOptions(input, options) {
    input.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  }

  function initializeOperations(project) {
    $('managedProviderEdit').value = project.provider;
    $('managedModelEdit').value = project.model;
    $('managedKeyEdit').value = '';
    $('manageActionCheck').checked = false;
    $('manageActionMessage').value = '';
    updateActionVerificationOptions();
    $('manageObservability').checked = project.observability;
    $('manageBudget').checked = Boolean(project.budget);
    $('budgetDay').value = project.budget?.day ?? 100;
    $('budgetMonth').value = project.budget?.month ?? 2000;
    $('budgetBreaker').value = project.budget?.breakerSeconds ?? 60;
    $('budgetMaintenance').checked = project.budget?.maintenance ?? false;
    $('budgetTurnstile').checked = project.budget?.turnstile ?? false;
    $('turnstileHost').value = project.budget?.turnstileHostname ?? '';
    $('backupProject').href = projectRoute('backup');
    $('reviewKvVersions').hidden = project.knowledgeMode !== 'kv';
    $('kvRollbackGroup').hidden = true;
    $('acceptRemote').hidden = true;
    $('promoteVersion').disabled = true;
    ['remoteReview','operationHistory','usageResult'].forEach(id => { $(id).textContent = ''; });
    renderOptions($('rollbackVersion'), [['','Review remote state to load verified versions']]);
    remoteReview = null; kvState = null; staged = null; compiledSections = undefined;
    $('sectionRows').replaceChildren();
    for (const section of project.sections ?? []) addSection(section);
    if (!project.sections && project.faq) addSection({ title: 'Business FAQ', type: 'faq', text: project.faq });
    if (!project.sections && project.instructions) addSection({ title: 'Business instructions', type: 'instructions', text: project.instructions });
    void api(projectRoute('architecture')).then(info => {
      if (managed !== project) return;
      $('architecture').textContent = `${info.mode} · ${info.faqBytes + info.instructionsBytes} bytes · ~${info.approximateContextTokens} context tokens · ${info.kvReadsPerChat} KV reads/chat. ${info.recommendation}`;
    }).catch(() => {});
    void api(projectRoute('staged')).then(info => {
      if (managed !== project) return;
      staged = info.staged; $('promoteVersion').disabled = !staged;
    }).catch(() => {});
    if (project.accountId) void api(projectRoute('live-endpoint')).then(info => {
      if (managed !== project) return;
      $('manageLiveUrl').href = new URL('/health', info.endpoint).href;
      $('manageLiveLinks').hidden = false;
    }).catch(() => {});
  }

  async function reviewRemote() {
    const worker = managed;
    const state = await api(projectRoute('remote-state'));
    if (managed !== worker) return;
    remoteReview = state;
    $('remoteReview').textContent = [
      'Status: ' + state.status,
      state.current && 'Deployment: ' + state.current.deployment,
      state.current && state.current.versions.map(version => version.id + ' (' + version.percentage + '%)').join('\n'),
      state.baseline && 'Previous deployment: ' + state.baseline.deployment,
      state.fields.length && 'Changed: ' + state.fields.join(', ')
    ].filter(Boolean).join('\n');
    $('acceptRemote').hidden = !['changed','untracked'].includes(state.status);
    renderOptions($('rollbackVersion'), [['','Select version'], ...state.verified.map(entry => [entry.id, entry.id + ' · ' + entry.checkedAt.slice(0, 10)])]);
  }

  async function acceptRemote() {
    if (!remoteReview?.fingerprint || !managed || window.prompt('Review the Cloudflare changes first. Type ' + managed.name + ' to save this remote baseline.') !== managed.name) return;
    await api(projectRoute('remote-baseline'), { method: 'POST', data: { fingerprint: remoteReview.fingerprint, revision: managed.revision,
      confirmName: managed.name, acknowledge: 'BASELINE' } });
    await reviewRemote();
  }

  async function kvVersions() {
    kvState = await api(projectRoute('kv-revisions'));
    $('kvRollbackGroup').hidden = false;
    renderOptions($('kvRollbackVersion'), [['', 'Select a stored revision'], ...kvState.revisions.map(entry => [
      entry.revision, entry.revision.slice(0, 16) + (entry.revision === kvState.active ? ' · active' : '') + (entry.publishedAt ? ' · ' + entry.publishedAt.slice(0, 10) : '')
    ])]);
  }

  async function readUsage() {
    const key = $('opsKey').value;
    $('opsKey').value = '';
    const usage = await api(projectRoute('usage'), { method: 'POST', data: { key } });
    const prices = ['priceInput','priceOutput'].map(id => $(id).value.trim());
    const threshold = Number($('usageThreshold').value);
    const costThreshold = Number($('usageCostThreshold').value);
    const failureThreshold = Number($('usageFailureThreshold').value);
    const report = (period, stat) => {
      const limit = usage.config[period];
      const percent = 100 * stat.calls / limit;
      const cost = prices.every(value => value !== '' && Number(value) >= 0)
        ? (stat.inputTokens * Number(prices[0]) + stat.outputTokens * Number(prices[1])) / 1e6 : null;
      const observed = stat.ok + stat.failures;
      const failureRate = observed ? 100 * stat.failures / observed : 0;
      const timing = observed ? Math.round(stat.latencyMs / observed) + ' ms average' : 'no latency samples';
      const alerts = [];
      if (threshold > 0 && percent >= threshold) alerts.push(`Budget alert · ${percent.toFixed(0)}% used.`);
      if (period === 'month' && cost !== null && costThreshold > 0 && cost >= costThreshold) alerts.push(`Cost alert · estimated spend reached $${costThreshold}.`);
      if (failureThreshold > 0 && failureRate >= failureThreshold) alerts.push(`Failure alert · ${failureRate.toFixed(0)}% of observed calls.`);
      return [
        `${period} · ${stat.calls}/${limit} reservations · ${stat.failures} failures · ${stat.quota} quota events · ${timing}`,
        `${stat.inputTokens} input / ${stat.outputTokens} output tokens across ${stat.meteredCalls} measured calls · ${stat.kvReads} KV reads`,
        ...(cost === null ? [] : [`Estimated provider cost · $${cost.toFixed(4)}`]),
        ...alerts
      ].join('\n');
    };
    $('usageResult').textContent = [usage.date + ' UTC', report('day', usage.day), report('month', usage.month),
      usage.breakerUntil > Date.now() && 'Quota circuit open until ' + new Date(usage.breakerUntil).toISOString()].filter(Boolean).join('\n\n');
  }

  async function operationsHistory(download = false) {
    const result = await api('/api/operations?name=' + encodeURIComponent(managed.name));
    if (download) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = managed.name + '-operations.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      const history = $('operationHistory');
      history.replaceChildren();
      if (!result.operations.length) {
        history.textContent = 'No operations recorded.';
        return;
      }
      for (const job of result.operations) {
        const row = document.createElement('div');
        row.className = 'operation-entry';
        const header = document.createElement('div');
        header.className = 'operation-entry-heading';
        const title = document.createElement('strong');
        title.textContent = (job.operation ?? job.mode) + ' · ' + job.status;
        const status = document.createElement('span');
        status.className = 'operation-dot';
        status.dataset.state = successfulStatuses.includes(job.status) ? 'success' : job.status;
        status.setAttribute('aria-hidden', 'true');
        header.append(status, title);
        row.append(header);
        const time = document.createElement('time');
        time.dateTime = job.createdAt;
        time.textContent = new Date(job.createdAt).toLocaleString();
        row.append(time);
        const checks = verificationSummary(job.verification ?? {}).map(item => item.label + ': ' + item.status.replaceAll('_', ' '));
        for (const text of [job.reason, checks.join(' · ')].filter(Boolean)) {
          const detail = document.createElement('p');
          detail.textContent = text;
          row.append(detail);
        }
        history.append(row);
      }
    }
  }

  function formField(parent, label, element) {
    const wrapper = document.createElement('label');
    wrapper.className = 'field';
    const title = document.createElement('span'); title.textContent = label;
    wrapper.append(title, element); parent.append(wrapper);
    return element;
  }

  function textField(parent, label, value, multiline = false) {
    const field = document.createElement(multiline ? 'textarea' : 'input');
    field.value = value ?? '';
    if (multiline) field.rows = 3;
    return formField(parent, label, field);
  }

  function removeButton(parent) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn ghost';
    button.textContent = 'Remove'; button.addEventListener('click', () => parent.remove()); parent.append(button);
  }

  function addSection(section = { title: '', type: 'faq', text: '' }) {
    const root = $('sectionRows');
    if (root.children.length >= 20) return;
    const row = document.createElement('section'); row.className = 'knowledge-section-row';
    textField(row, 'Section title', section.title);
    const type = document.createElement('select');
    renderOptions(type, [['faq','FAQ'], ['instructions','Instructions']]); type.value = section.type;
    formField(row, 'Knowledge type', type);
    textField(row, 'Section text', section.text, true);
    removeButton(row); root.append(row);
  }

  function compileEditors(sections, faq, instructions) {
    for (const type of ['faq','instructions']) {
      $(type === 'faq' ? faq : instructions).value = sections.filter(section => section.type === type)
        .map(section => '## ' + section.title.trim() + '\n\n' + section.text.trim()).join('\n\n');
    }
  }

  function addVisualAction(action = { id: '', description: '', parameters: {} }) {
    const root = $('visualActionRows');
    if (root.children.length >= 8) return;
    const row = document.createElement('section'); row.className = 'action-form-row';
    const id = textField(row, 'Action ID', action.id);
    textField(row, 'Description', action.description);
    const parameters = Object.entries(action.parameters);
    const group = document.createElement('fieldset');
    group.className = 'action-parameters';
    const title = document.createElement('legend');
    title.textContent = 'Optional parameters';
    group.append(title);
    for (let i = 0; i < 3; i++) {
      const parameter = parameters[i];
      const details = document.createElement('details');
      details.open = Boolean(parameter);
      const summary = document.createElement('summary');
      summary.textContent = 'Parameter ' + (i + 1);
      const fields = document.createElement('div');
      fields.className = 'parameter-fields';
      const name = textField(fields, 'Name', parameter?.[0]);
      textField(fields, 'Allowed values (one per line)', parameter?.[1].enum.join('\n'), true);
      if (parameter) {
        const tag = document.createElement('span');
        tag.className = 'tiny-tag';
        tag.textContent = parameter[0];
        name.addEventListener('input', () => { tag.textContent = name.value; tag.hidden = !name.value.trim(); });
        summary.append(tag);
      }
      details.append(summary, fields);
      group.append(details);
    }
    row.append(group);
    removeButton(row);
    root.append(row);
    if ($('actionDialog').open) id.focus();
  }

  function openActions(target) {
    actionTarget = target;
    $('visualActionRows').replaceChildren();
    $('actionSimulation').textContent = '';
    const actions = readActionEditor(target);
    for (const action of actions) addVisualAction(action);
    if (!actions.length) addVisualAction();
    $('actionDialog').showModal();
  }

  async function validateVisualActions(simulate) {
    const actions = [...$('visualActionRows').children].map(row => {
      const [id, description, ...fields] = [...row.querySelectorAll('input,textarea')].map(input => input.value.trim());
      const parameters = [];
      for (let i = 0; i < fields.length; i += 2) {
        const [name, values] = fields.slice(i, i + 2);
        if (name || values) {
          if (parameters.some(([key]) => key === name)) throw new Error('Each parameter name must be unique.');
          parameters.push([name, { type: 'string', enum: values.split('\n').map(value => value.trim()).filter(Boolean) }]);
        }
      }
      return { id, description, parameters: Object.fromEntries(parameters) };
    });
    const data = await api('/api/actions/validate', { method: 'POST', data: { actions, simulate } });
    if (simulate) {
      $('actionSimulation').textContent = data.simulation ? JSON.stringify(data.simulation) : 'Add an action to simulate it.';
    } else {
      $(actionTarget).value = JSON.stringify(data.actions, null, 2);
      $('actionDialog').close();
      if (actionTarget === 'manageActions') updateManageDiff(); else updateSummary(); updateActionVerificationOptions();
    }
  }

  async function importProject() {
    setManageError('');
    const sourcePath=$('importPath').value.trim();
    if (!sourcePath) { setManageError('Paste the complete path to the original generated project.'); return; }
    if (!window.confirm('Copy this existing Falco project into this Factory installation?')) return;
    try {
      const { project }=await api('/api/projects/import',{method:'POST',data:{sourcePath,
        ...(remoteSelected ? { expectedWorker: remoteSelected.name, expectedAccountId: remoteSelected.accountId } : {}) }});
      await loadProjects();
      $('importPath').value=''; $('importPanel').open=false;
      await loadManagedProject(project.folder,{force:true});
      if (remoteAccount) void refreshRemoteWorkers();
    } catch(err) { setManageError(err.message); }
  }
  async function updateJob() {
    if (!activeJobId) return;
    try {
      const result=await api(`/api/jobs/${activeJobId}`), job=result.job;
      const isManage=jobArea==='manage';
      const target=isManage?'manageConsoleBody':'consoleBody';
      if (job.events.length !== lastEventCount) {
        $(target).replaceChildren();
        for (const event of job.events) logLine(event.message,event.stage==='done'?'success':event.stage==='warning'?'warning':event.stage==='error'?'error':'info',target,event);
        lastEventCount=job.events.length;
      }
      const finished=['failed','partial','generated','deployed','updated','restored','checked','cancelled','interrupted'].includes(job.status);
      const label = job.readiness === 'ready' ? 'READY' : job.readiness ? job.status.toUpperCase() + ' · CHECKS PENDING' : job.status.toUpperCase();
      consoleStatus(label, isManage ? 'manageConsoleStatus' : 'consoleStatus', job.readiness === 'ready' ? 'ready' : job.status);
      if (finished) {
        window.clearInterval(pollHandle); pollHandle=null;
        $('cancelCreateJob').hidden = true; $('cancelManageJob').hidden = true;
        for (const item of verificationSummary(job.verification ?? {})) {
          const text = item.label + ': ' + item.status.replaceAll('_', ' ');
          logLine(text, item.tone, target);
        }
        if (isManage) {
          if (managed) await loadManagedProject(managed.folder,{force:true});
          if (['failed','partial','cancelled'].includes(job.status)) setManageError(job.error || 'Review the release log.');
          if (job.url && managed?.name===job.name) { $('manageLiveUrl').href=job.url+'/health'; $('manageLiveLinks').hidden=false; }
          await loadProjects();
        } else {
          busy(false);
          if (job.status==='failed'||job.status==='partial') setError(job.error||'Build failed');
          if (job.url) { $('workerLink').href=job.url+'/health'; $('workerLink').textContent='Open live /health ↗︎'; $('resultLinks').hidden=false; $('testChat').hidden=false; }
          if (job.status==='generated'||job.status==='deployed') void loadProjects();
        }
        activeJobId=job.id;
        activeJobMode='';
      }
    } catch(err) {
      window.clearInterval(pollHandle);pollHandle=null;
      if (jobArea==='manage') setManageError(err.message); else { busy(false);setError(err.message); }
    }
  }
  function renderAuthDiagnostics(status) {
    const set = (id, value, tone = '') => {
      const el = $(id); if (!el) return;
      el.textContent = value || 'Unknown';
      el.classList.remove('auth-good','auth-warn','auth-bad');
      if (tone) el.classList.add(tone);
    };
    set('authMethodValue', status.authMethodLabel || 'Not authenticated', status.factoryCompatible ? 'auth-good' : 'auth-warn');
    set('authStorageValue', status.credentialStorageLabel || 'Unknown', status.secureStorage ? 'auth-good' : 'auth-warn');
    const read = status.permissions?.workersRead;
    set('authWorkersReadValue', read?.label || 'Not checked', read?.status === 'passed' ? 'auth-good' : read?.status === 'failed' ? 'auth-bad' : 'auth-warn');
    set('authWriteValue', 'Deployment and KV writes are not tested by diagnostics', '');
    $('authRecommendation').textContent = status.recommendation || 'No additional recommendation.';
  }
  async function checkCloudflare() {
    try {
      const selected = $('accountId')?.value.trim() || $('remoteAccountSelect')?.value || '';
      const suffix = selected && /^[a-f0-9]{32}$/i.test(selected) ? `?accountId=${encodeURIComponent(selected)}` : '';
      const status = await api('/api/cloudflare' + suffix);
      $('cloudflareDot').className = status.connected && status.factoryCompatible ? 'status-light online' : 'status-light offline';
      $('cloudflareState').textContent = status.connected ? (status.factoryCompatible ? 'Cloudflare connected' : 'Authentication needs attention') : 'Cloudflare not connected';
      const storageShort = status.secureStorage ? 'keychain protected' : status.authMethod === 'api_token' ? 'API token' : 'storage not protected';
      $('cloudflareSub').textContent = status.connected ? `${status.accounts.length || 'Authenticated'} account${status.accounts.length === 1 ? '' : 's'} · ${status.authMethodLabel || 'Wrangler'} · ${storageShort}` : 'Run secure Wrangler login';
      if (status.selectedAccount && !$('accountId').value) $('accountId').value = status.selectedAccount;
      populateCloudAccounts(status);
      renderAuthDiagnostics(status);
    } catch (error) {
      $('cloudflareDot').className = 'status-light offline';
      $('cloudflareState').textContent = 'Cloudflare status unknown';
      $('cloudflareSub').textContent = 'Check Wrangler installation';
      renderAuthDiagnostics({ recommendation: error.message });
    }
  }
  async function loadExample() {
    switchMode('create');
    try {
      const example = await api('/api/example/gallinas');
      for (const key of ['business','name','origin','faq','instructions']) $(key).value = example[key];
      userEditedName = true;
      $('actions').value = JSON.stringify(example.actions ?? [], null, 2);
      form.querySelector('input[name="knowledgeMode"][value="embedded"]').checked = true;
      lastAutoName = example.name;
      form.querySelector('input[name="provider"][value="mock"]').checked = true;
      selectedProviderChanged();
      updateSummary(); updateActionVerificationOptions();
      setError('');
      $('sectionIdentity').scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' });
    } catch (err) { setError(err.message); }
  }
  async function importText(key, input) {
    const file = input.files?.[0];
    if (!file) return;
    const kv = knowledgeMode() === 'kv';
    const max = key === 'faq' ? (kv?96000:24000) : (kv?24000:12000);
    if (file.size > max) { setError(`File too large: ${file.name}. Maximum ${max / 1000} KB.`); input.value = ''; return; }
    try { $(key).value = await file.text(); updateSummary(); setError(''); }
    catch { setError('Could not read this file. Use a UTF-8 Markdown or text document.'); }
    input.value = '';
  }
  async function testChat() {
    if (!activeJobId) return;
    const question = $('testMessage').value.trim();
    if (!question) return;
    if (activeJobProvider !== 'mock' && !window.confirm('This sends a real AI request and may incur provider usage fees. Continue?')) return;
    const button = $('sendTestBtn');
    button.disabled = true;
    $('testReply').textContent = 'Sending request to your Cloudflare Worker...';
    try {
      const data = await api(`/api/jobs/${activeJobId}/chat`, { method: 'POST', data: { message: question } });
      $('testReply').textContent = `Falco: ${data.reply}` + (data.action ? `\nProposed action (preview only, not executed in Studio): ${JSON.stringify(data.action)}` : '');
    } catch (err) { $('testReply').textContent = err.message; }
    finally { button.disabled = false; }
  }
  function openWorkerChat(item) {
    ++chatRequestSerial;
    chatWorker = { name: item.name, accountId: item.accountId, provider: item.provider };
    $('workerChatName').textContent = item.name;
    $('workerChatReply').textContent = '';
    $('workerChatSend').disabled = false;
    $('workerChatDialog').showModal();
    $('workerChatMessage').focus();
    $('workerChatMessage').select();
  }
  async function sendWorkerChat() {
    if (!chatWorker || $('workerChatSend').disabled) return;
    const message = $('workerChatMessage').value.trim();
    if (!message) return;
    if (chatWorker.provider !== 'mock' && !window.confirm('This sends a REAL AI request and may use your provider quota. Continue?')) return;
    const requestId = ++chatRequestSerial;
    const worker = chatWorker;
    $('workerChatSend').disabled = true;
    $('workerChatReply').textContent = 'Contacting ' + worker.name + '…';
    try {
      const data = await api('/api/cloudflare/workers/chat', { method: 'POST', data: { accountId: worker.accountId, name: worker.name, message } });
      if (requestId !== chatRequestSerial) return;
      $('workerChatReply').textContent = 'Falco: ' + data.reply + (data.action ? `\nProposed action (preview only): ${JSON.stringify(data.action)}` : '');
    } catch (error) {
      if (requestId === chatRequestSerial) $('workerChatReply').textContent = error.message;
    } finally {
      if (requestId === chatRequestSerial) $('workerChatSend').disabled = false;
    }
  }
  async function manageTestChat() {
    if (!managed?.accountId || $('manageTestSend').disabled) return;
    const project = managed;
    const question=$('manageTestMessage').value.trim();
    if (!question) return;
    if (project.provider !== 'mock' && !window.confirm('This sends a REAL AI request and may use your provider quota. Continue?')) return;
    const requestId = ++manageChatSerial;
    const button=$('manageTestSend'); button.disabled=true;
    $('manageTestReply').textContent='Contacting your deployed Worker...';
    try {
      const reply=await api('/api/cloudflare/workers/chat',{method:'POST',data:{accountId:project.accountId,name:project.name,message:question}});
      if (managed !== project || requestId !== manageChatSerial) return;
      $('manageTestReply').textContent='Falco: '+reply.reply+(reply.action ? `\nProposed action (preview only): ${JSON.stringify(reply.action)}` : '');
    } catch(err) { if (managed === project && requestId === manageChatSerial) $('manageTestReply').textContent=err.message; }
    finally { if (managed === project && requestId === manageChatSerial) button.disabled=false; }
  }
  function listen() {
    $('workerChatForm').addEventListener('submit', event => { event.preventDefault(); void sendWorkerChat(); });
    $('closeWorkerChat').addEventListener('click', () => $('workerChatDialog').close());
    $('workerChatDialog').addEventListener('close', () => { ++chatRequestSerial; chatWorker = null; });
    $('toggleSidebar').addEventListener('click', () => {
      setSidebar($('toggleSidebar').getAttribute('aria-expanded') === 'false');
    });
    $('openAuth').addEventListener('click', () => {
      setSidebar(true);
      $('authDiagnosticsPanel').open = true;
      const summary = $('authDiagnosticsPanel').querySelector('summary');
      summary.focus({ preventScroll: true });
      summary.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'nearest' });
    });
    $('manageOpsLink').addEventListener('click', () => { $('operationsPanel').open = true; });
    for (const tab of [$('createNav'), $('manageNav')]) {
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const create = event.key === 'Home' || (event.key !== 'End' && tab.id === 'manageNav');
        switchMode(create ? 'create' : 'manage');
        $(create ? 'createNav' : 'manageNav').focus();
      });
    }
    $('business').addEventListener('input', () => {
      const workerName = 'falco-' + slug($('business').value);
      if (!userEditedName || $('name').value === lastAutoName) {
        $('name').value = workerName.length > 6 ? workerName : '';
        lastAutoName = $('name').value;
      }
      updateSummary();
    });
    $('name').addEventListener('input', () => { userEditedName = true; updateSummary(); });
    for (const key of ['origin','model','faq','instructions','mockReply']) $(key).addEventListener('input', updateSummary);
    $('actions').addEventListener('input', () => { updateSummary(); updateActionVerificationOptions(); });
    for (const r of form.querySelectorAll('input[name="provider"]')) r.addEventListener('change', selectedProviderChanged);
    $('force').addEventListener('change', () => { $('confirmationArea').hidden = !$('force').checked; });
    $('toggleKey').addEventListener('click', () => {
      const show = $('apiKey').type === 'password';
      $('apiKey').type = show ? 'text' : 'password';
      $('toggleKey').textContent = show ? 'Hide' : 'Show';
    });
    $('faqFile').addEventListener('change', () => importText('faq', $('faqFile')));
    $('instructionsFile').addEventListener('change', () => importText('instructions', $('instructionsFile')));
    $('previewBtn').addEventListener('click', runPreview);
    $('generateBtn').addEventListener('click', () => runBuild('generate'));
    $('deployBtn').addEventListener('click', () => runBuild('deploy'));
    $('sidebarExample').addEventListener('click', loadExample);
    $('sidebarCreate').addEventListener('click', () => switchMode('create'));
    $('sidebarManage').addEventListener('click', () => switchMode('manage'));
    $('createNav').addEventListener('click', () => switchMode('create'));
    $('manageNav').addEventListener('click', () => switchMode('manage'));
    $('manageProject').addEventListener('change', () => void loadManagedProject($('manageProject').value));
    $('refreshCloudWorkers').addEventListener('click', () => void refreshRemoteWorkers());
    $('remoteAccountSelect').addEventListener('change', () => void refreshRemoteWorkers());
    $('remoteAccountManual').addEventListener('change', () => void refreshRemoteWorkers());
    $('remoteLinkButton').addEventListener('click', () => { $('importPanel').open = true; $('importPath').focus(); $('importPanel').scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'nearest' }); });
    $('manageFaq').addEventListener('input', updateManageDiff);
    $('manageInstructions').addEventListener('input', updateManageDiff);
    $('manageOrigins').addEventListener('input', updateManageDiff);
    $('manageActions').addEventListener('input', () => { updateManageDiff(); updateActionVerificationOptions(); });
    $('clearActions').addEventListener('click', () => { $('actions').value='[]'; updateSummary(); updateActionVerificationOptions(); });
    $('useGallinasActions').addEventListener('click', () => { $('actions').value=JSON.stringify(GALLINAS_ACTION_PRESET,null,2); updateSummary(); updateActionVerificationOptions(); });
    $('manageGallinasPreset').addEventListener('click', () => { $('manageActions').value=JSON.stringify(GALLINAS_ACTION_PRESET,null,2); updateManageDiff(); updateActionVerificationOptions(); });
    $('saveDeploy').addEventListener('click', () => void startManageJob('update'));
    $('knowledgeMode').addEventListener('change', updateSummary);
    $('upgradeDiagnostics').addEventListener('click', () => void startManageJob('upgrade-runtime'));
    $('enableKvKnowledge').addEventListener('click', () => void startManageJob('enable-kv'));
    $('republishKvKnowledge').addEventListener('click', () => void startManageJob('publish-kv'));
    $('discardChanges').addEventListener('click', () => { if (managed) { compiledSections = undefined; $('manageFaq').value=managed.faq; $('manageInstructions').value=managed.instructions; $('manageOrigins').value=(managed.origins ?? [managed.origin]).join('\n'); $('manageActions').value=JSON.stringify(managed.actions ?? [],null,2); updateManageDiff(); updateActionVerificationOptions(); } });
    $('importBtn').addEventListener('click', importProject);
    $('manageTestSend').addEventListener('click', manageTestChat);
    $('manageTestMessage').addEventListener('keydown', e => { if(e.key==='Enter'){e.preventDefault();void manageTestChat();} });
    $('sendTestBtn').addEventListener('click', testChat);
    $('testMessage').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void testChat(); } });
    form.addEventListener('submit', event => event.preventDefault());
    const bind = (id, action, output = setManageError) => $(id).addEventListener('click', () =>
      Promise.resolve().then(action).catch(error => output(error.message)));
    bind('refreshAuthDiagnostics', checkCloudflare, message => { $('authRecommendation').textContent = message; });
    bind('copyAuthSecureCommand', async () => {
      await navigator.clipboard.writeText('npm.cmd run falco:auth:secure');
      $('authRecommendation').textContent = 'Copied: npm.cmd run falco:auth:secure. Run it in PowerShell from the Falco Factory folder.';
    }, message => { $('authRecommendation').textContent = message; });
    $('workerSearch').addEventListener('input', renderRemoteWorkers);
    $('remoteAccountSelect').addEventListener('change', () => void checkCloudflare());
    for (const id of ['faq','instructions']) $(id).addEventListener('input', () => { createSections = undefined; });
    for (const id of ['manageFaq','manageInstructions']) $(id).addEventListener('input', () => { compiledSections = undefined; });
    bind('applyVertical', async () => {
      if (($('faq').value || $('instructions').value) && !window.confirm('Replace both knowledge editors with the selected starter?')) return;
      const { verticals } = await api('/api/verticals');
      createSections = verticals[$('verticalPreset').value].sections;
      compileEditors(createSections, 'faq', 'instructions'); updateSummary();
    }, setError);
    bind('preflightProvider', async () => {
      const d = config();
      if (d.provider !== 'mock' && !window.confirm('Authorize one direct provider call with a short test prompt?')) return;
      const result = await api('/api/provider-check', { method: 'POST', data: { provider: d.provider, model: d.model,
        apiKey: $('apiKey').value.trim(), actionMode: d.actions.length > 0, authorize: true } });
      logLine(result.provider + ' accepted ' + result.model + (result.actionMode ? ' and returned valid action JSON.' : ' and returned valid text.'), 'success');
    }, setError);
    bind('reviewRemote', reviewRemote);
    bind('acceptRemote', acceptRemote);
    bind('runLiveCheck', async () => {
      const checkAction = $('manageActionCheck').checked;
      const checkChat = $('manageProviderCheck').checked || managed.provider === 'mock';
      const actionMessage = $('manageActionMessage').value.trim();
      if (!checkChat && !checkAction) throw new Error('Authorize a chat request or enable the Client Action test first.');
      if (checkAction && actionMessage.length < 3) throw new Error('Enter a test message of at least 3 characters.');
      const description = checkAction
        ? 'Run one live provider request to verify chat and the first configured Client Action proposal. The website action will not execute. Provider charges may apply.'
        : 'Run one live chat request. Provider charges may apply.';
      if (!window.confirm(description)) return;
      await startManageJob('check-provider', '', { checkProvider: checkChat || checkAction, checkAction, ...(checkAction ? { actionMessage } : {}) });
    });
    bind('stageVersion', () => startManageJob('stage'));
    bind('promoteVersion', () => staged && startManageJob('promote', staged.id));
    bind('rollbackWorker', () => $('rollbackVersion').value && startManageJob('rollback', $('rollbackVersion').value));
    bind('reviewKvVersions', kvVersions);
    bind('rollbackKv', () => kvState && $('kvRollbackVersion').value && startManageJob('kv-rollback', $('kvRollbackVersion').value, { expectedActive: kvState.active }));
    bind('showHistory', () => operationsHistory());
    bind('exportHistory', () => operationsHistory(true));
    bind('readUsage', readUsage);
    bind('cloneProject', async () => {
      const business = window.prompt('Cloned project business name');
      if (!business) return;
      const name = window.prompt('New Worker name', 'falco-' + slug(business));
      if (!name) return;
      const origins = window.prompt('Allowed website origins, separated by commas', managed.origins.join(', '));
      if (!origins) return;
      await api(projectRoute('clone'), { method: 'POST', data: { name, business, origins } });
      await loadProjects(); await loadManagedProject(name);
    });
    $('managedProviderEdit').addEventListener('change', () => { $('managedModelEdit').value = models[$('managedProviderEdit').value]; updateActionVerificationOptions(); });
    bind('updateProviderSettings', () => {
      const selected = $('managedProviderEdit').value;
      const apiKey = $('managedKeyEdit').value.trim();
      const precheck = Boolean(apiKey) && selected !== 'mock';
      if (precheck && !window.confirm('Authorize one direct compatibility check for this credential and model?')) return;
      return startManageJob('settings', '', { provider: selected, model: $('managedModelEdit').value.trim(), apiKey, precheck,
        checkProvider: selected === 'mock' || $('manageProviderCheck').checked,
        observability: $('manageObservability').checked, budget: $('manageBudget').checked ? {
          day: Number($('budgetDay').value), month: Number($('budgetMonth').value), breakerSeconds: Number($('budgetBreaker').value),
          maintenance: $('budgetMaintenance').checked, turnstile: $('budgetTurnstile').checked, turnstileHostname: $('turnstileHost').value.trim()
        } : null });
    });
    bind('rotateProviderKey', () => {
      const apiKey = $('managedKeyEdit').value.trim();
      if (apiKey && window.confirm('Authorize one compatibility check for the new key?')) return startManageJob('replace-secret', '', { apiKey, precheck: true });
    });
    bind('cancelCreateJob', () => api('/api/jobs/' + activeJobId + '/cancel', { method: 'POST', data: {} }), setError);
    bind('cancelManageJob', () => api('/api/jobs/' + activeJobId + '/cancel', { method: 'POST', data: {} }));
    bind('createVisualActions', () => openActions('actions'), setError);
    bind('manageVisualActions', () => openActions('manageActions'));
    bind('addVisualAction', () => addVisualAction());
    bind('closeActions', () => $('actionDialog').close());
    const actionError = message => { $('actionSimulation').textContent = message; };
    bind('applyActions', () => validateVisualActions(false), actionError);
    bind('simulateActions', () => validateVisualActions(true), actionError);
    bind('addKnowledgeSection', () => addSection());
    bind('useSections', () => {
      compiledSections = [...$('sectionRows').children].map(row => {
        const [title, type, text] = [...row.querySelectorAll('input,select,textarea')].map(input => input.value);
        return { title, type, text };
      });
      compileEditors(compiledSections, 'manageFaq', 'manageInstructions'); updateManageDiff();
    });
    const steps = [...$('createView').querySelectorAll('.step-pill')];
    const sections = steps.map(step => $(step.hash.slice(1)));
    const markCurrentStep = () => {
      if ($('createView').hidden) return;
      const current = sections.findLastIndex(section => section.getBoundingClientRect().top <= 145);
      steps.forEach((step, index) => {
        if (index === Math.max(0, current)) step.setAttribute('aria-current', 'location');
        else step.removeAttribute('aria-current');
      });
    };
    window.addEventListener('scroll', markCurrentStep, { passive: true });
    window.addEventListener('resize', markCurrentStep);
  }
  async function init() {
    listen();
    updateSummary();
    updateActionVerificationOptions();
    try {
      const boot = await api('/api/bootstrap');
      token = boot.token;
      Object.assign(models, boot.defaultModels);
      void loadProjects();
      void checkCloudflare();
    } catch (err) {
      setError(`Local Studio connection failed: ${err.message}`);
      busy(true);
    }
  }
  void init();
})();
