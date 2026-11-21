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
  let activeJobWorker = '';
  let managed = null;
  let projectRows = [];
  let remoteRows = [];
  let remoteAccount = '';
  let remoteSelected = null;
  let remoteFetching = false;
  let remoteFetchSerial = 0;
  const enc = new TextEncoder();
  const byteLength = t => enc.encode(t).byteLength;
  const provider = () => form.querySelector('input[name="provider"]:checked').value;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    updateSummary();
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
    for (const [key, limit] of [['faq', 24000], ['instructions', 12000]]) {
      const count = byteLength($(key).value);
      const el = $(`${key}Size`);
      el.textContent = `${(count / 1000).toFixed(count ? 1 : 0)} / ${limit / 1000} KB`;
      el.classList.toggle('over', count > limit);
    }
  }
  function config() {
    return {
      business: $('business').value.trim(), name: $('name').value.trim(),
      provider: provider(), model: $('model').value.trim(), origins: $('origin').value.split(/[\n,]/).map(x=>x.trim()).filter(Boolean),
      instructions: $('instructions').value, faq: $('faq').value,
      mockReply: $('mockReply').value.trim(),
      rateLimit: $('rateLimit').value.trim(), outputFolder: $('outputFolder').value.trim(),
      accountId: $('accountId').value.trim(), force: $('force').checked,
      confirmName: $('confirmName').value.trim(),
    };
  }
  function assertLocalConfig() {
    const d = config();
    if (!d.business || d.business.length < 2) throw new Error('Enter a business name (at least 2 characters).');
    if (!/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(d.name)) throw new Error('Worker name must be 3–63 characters, lowercase letters, numbers or hyphens.');
    if (d.force && d.confirmName !== d.name) throw new Error('To allow replacement, type the exact Worker name in Advanced configuration.');
    if (byteLength(d.faq) > 24000 || byteLength(d.instructions) > 12000) throw new Error('A knowledge document exceeds its size limit.');
    return d;
  }
  function clearConsole() {
    $('consoleBody').replaceChildren();
    $('resultLinks').hidden = true;
    $('testChat').hidden = true;
  }
  function logLine(message, kind = 'info', target = 'consoleBody') {
    const row = document.createElement('div');
    row.className = `console-line ${kind}`;
    const mark = document.createElement('span');
    mark.textContent = kind === 'success' ? '✓' : kind === 'error' ? '×' : kind === 'warning' ? '!' : '›';
    row.append(mark, document.createTextNode(message));
    $(target).appendChild(row);
    $(target).scrollTop = $(target).scrollHeight;
  }
  function consoleStatus(text) { $('consoleStatus').textContent = text; }
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
      logLine(result.localExists ? 'Local project exists — replacement confirmation needed.' : 'Local project name available.', result.localExists ? 'warning' : 'success');
      logLine('Preview only. No files written or Cloudflare changes.', 'muted');
      consoleStatus('VALIDATED');
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
      if (mode === 'deploy' && !window.confirm(`Deploy ${d.name} to your Cloudflare account?\n\n${d.force ? 'WARNING: you authorized replacement of an existing Worker.' : 'Existing Workers will not be overwritten.'}`)) return;
      busy(true);
      clearConsole();
      consoleStatus('STARTING');
      logLine(`Starting ${mode === 'deploy' ? 'Cloudflare deployment' : 'local generation'}...`);
      const payload = { ...d, mode, ...(mode === 'deploy' ? { apiKey: $('apiKey').value.trim() } : {}) };
      const result = await api('/api/jobs', { method: 'POST', data: payload });
      // Never retain a provider key in the UI after it has been submitted.
      $('apiKey').value = '';
      activeJobId = result.job.id;
      jobArea = 'create';
      activeJobProvider = d.provider;
      activeJobWorker = d.name;
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
    $('sidebarCreate').classList.toggle('active', !isManage);
    $('sidebarManage').classList.toggle('active', isManage);
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'instant' : 'smooth' });
    if (isManage && !remoteFetching) void refreshRemoteWorkers();
  }
  function cloudStatus(message, { error = false } = {}) {
    $('remoteWorkerStatus').textContent = message;
    $('remoteWorkerStatus').classList.toggle('error', error);
  }
  function renderRemoteWorkers() {
    const list = $('remoteWorkerList');
    list.replaceChildren();
    $('remoteWorkerCount').textContent = String(remoteRows.length);
    if (!remoteRows.length) {
      const empty = document.createElement('div');
      empty.className = 'remote-empty';
      empty.textContent = 'No Worker scripts found in this Cloudflare account. Check the selected account, or create your first Falco.';
      list.append(empty); return;
    }
    for (const item of remoteRows) {
      const card = document.createElement('div');
      card.className = 'remote-worker-card';
      const glyph = document.createElement('span'); glyph.className = 'remote-glyph'; glyph.textContent = '↗';
      const info = document.createElement('div'); info.className = 'remote-worker-detail';
      const title = document.createElement('strong'); title.textContent = item.name;
      const subtitle = document.createElement('small');
      subtitle.textContent = item.source === 'linked'
        ? `${item.business || 'Falco'} · ${item.provider || 'Worker'} · local source linked`
        : item.source === 'account-mismatch' ? 'Local source found, but it belongs to another Cloudflare account'
        : 'Deployed on Cloudflare · local source not linked';
      info.append(title, subtitle);
      const actions = document.createElement('div'); actions.className = 'remote-worker-actions';
      const badge = document.createElement('span'); badge.className = 'remote-worker-badge ' + (item.editable ? 'linked' : 'remote-only');
      badge.textContent = item.editable ? 'EDITABLE' : item.source === 'account-mismatch' ? 'ACCOUNT MISMATCH' : 'REMOTE ONLY';
      const buttonRow = document.createElement('div'); buttonRow.className = 'remote-button-row';
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'remote-load';
      btn.textContent = 'Load Worker ↗';
      btn.title = 'Open knowledge editor and automatically find an older Falco source';
      btn.addEventListener('click', () => void loadRemoteWorker(item, btn));
      const kit = document.createElement('button'); kit.type = 'button'; kit.className = 'remote-export';
      kit.textContent = 'Export frontend kit ↓';
      kit.title = 'Download neutral HTML/CSS/JS integration ZIP for your website agent';
      kit.addEventListener('click', () => void exportFrontendKit(item, kit));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remote-delete';
      remove.textContent = 'Delete';
      remove.title = 'Permanently delete this Worker on Cloudflare';
      remove.addEventListener('click', () => void deleteRemoteWorker(item, remove));
      buttonRow.append(btn,kit,remove);
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
        body: JSON.stringify({ accountId:item.accountId, name:item.name }),
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
      cloudStatus(`${item.name} loaded. Edit its knowledge below; no redeployment happened.`);
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
    if (!managed) return { changed: false, faqChanged: false, instructionsChanged: false, originsChanged: false };
    const faqChanged = $('manageFaq').value !== managed.faq;
    const instructionsChanged = $('manageInstructions').value !== managed.instructions;
    const originalOrigins = managed.origins ?? [managed.origin];
    const editedOrigins = $('manageOrigins').value.split(/[\n,]/).map(s=>s.trim()).filter(Boolean);
    const originsChanged = JSON.stringify(editedOrigins) !== JSON.stringify(originalOrigins);
    return { faqChanged, instructionsChanged, originsChanged, changed: faqChanged || instructionsChanged || originsChanged };
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
    for (const [key, changed] of [['Faq',changes.faqChanged],['Instructions',changes.instructionsChanged],['Origins',changes.originsChanged]]) {
      const chip = $(key === 'Faq' ? 'faqChange' : key === 'Origins' ? 'originsChange' : 'instructionsChange');
      chip.textContent = changed ? 'MODIFIED' : 'UNCHANGED';
      chip.classList.toggle('modified', changed);
    }
    const limits = [['manageFaq',24000],['manageInstructions',12000]];
    let invalid = false;
    for (const [id,max] of limits) {
      const size = byteLength($(id).value);
      const counter = $(id+'Size');
      counter.textContent = `${(size/1000).toFixed(1)} / ${max/1000} KB`;
      counter.classList.toggle('over', size > max);
      invalid ||= size > max;
    }
    const originRows = $('manageOrigins').value.split(/[\n,]/).map(s=>s.trim()).filter(Boolean);
    invalid ||= !originRows.length || originRows.length > 20 || originRows.some(x => !/^https?:\/\/[^/?#\s]+$/.test(x));
    $('saveDeploy').disabled = !changes.changed || invalid || !managed || Boolean(pollHandle);
    $('manageChangeHeadline').textContent = invalid ? 'Knowledge exceeds the size limit' : changes.changed ? 'Changes ready to review' : 'Everything is up to date';
    $('manageChangeDetail').textContent = invalid ? 'Shorten the highlighted text before deploying.' : changes.changed ? 'A version backup will be created before publishing the update.' : 'Make an edit to preview what will be deployed.';
    const diff = $('manageDiff');
    diff.replaceChildren();
    diff.hidden = !changes.changed;
    if (managed && changes.changed) {
      for (const [title, original, updated] of [['FAQ', managed.faq, $('manageFaq').value],['Instructions',managed.instructions,$('manageInstructions').value],['Allowed origins',(managed.origins ?? [managed.origin]).join('\n'),$('manageOrigins').value]]) {
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
        const button = document.createElement('button'); button.type='button'; button.className='restore-button'; button.textContent='Restore';
        button.addEventListener('click', () => void startManageJob('restore',entry.id));
        row.append(detail,button); list.appendChild(row);
      }
    } catch (err) { const row=document.createElement('div'); row.className='history-empty'; row.textContent=err.message; list.append(row); }
  }
  async function loadManagedProject(folder, { force = false } = {}) {
    if (!folder) { managed = null; $('manageEditorPanel').hidden = true; $('manageProjectInfo').hidden = true; updateManageDiff(); return; }
    if (!force && managed && currentManageChanges().changed && !window.confirm('Discard your unsaved knowledge edits?')) {
      $('manageProject').value = managed.folder; return;
    }
    setManageError('');
    $('manageLiveLinks').hidden = true;
    $('manageTestChat').hidden = true;
    try {
      const { project } = await api(`/api/projects/${encodeURIComponent(folder)}`);
      managed = project;
      remoteSelected = null;
      $('remoteSelection').hidden = true;
      $('linkTargetMessage').hidden = true;
      $('manageProject').value = folder;
      $('manageEditorPanel').hidden = false;
      $('manageProjectInfo').hidden = false;
      $('manageFaq').value = project.faq;
      $('manageInstructions').value = project.instructions;
      $('manageOrigins').value = (project.origins ?? [project.origin]).join('\n');
      $('managedBusiness').textContent = project.business;
      $('managedWorker').textContent = project.name;
      $('managedProvider').textContent = `${project.provider} · ${project.model}`;
      $('managedAccount').textContent = project.accountId ? project.accountId.slice(0,6)+'…'+project.accountId.slice(-4) : 'Not set';
      $('manageIdentityName').textContent = project.name;
      $('manageIdentitySub').textContent = `${project.business} · ${project.provider}`;
      updateManageDiff();
      await loadVersions();
    } catch (err) { managed=null; setManageError(err.message); }
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
  async function startManageJob(operation, versionId = '') {
    if (!managed || pollHandle) return;
    setManageError('');
    const changes = currentManageChanges();
    if (operation === 'update' && !changes.changed) return;
    if (operation === 'restore' && changes.changed && !window.confirm('You have UNSAVED text edits. Restoring a snapshot will discard those browser edits. Continue?')) return;
    if (byteLength($('manageFaq').value)>24000 || byteLength($('manageInstructions').value)>12000) { setManageError('Knowledge document exceeds its size limit.'); return; }
    const label = operation === 'restore' ? 'RESTORE' : 'UPDATE';
    const question = operation === 'restore'
      ? `Restore this previous knowledge version to ${managed.name}?\n\nThis redeploys the existing Worker. A backup of the current version is saved first.`
      : `Publish your changes to ${managed.name}?\n\nThis may update the CORS origin allowlist. Your Worker URL and API key secrets are preserved. A local snapshot is saved before deployment.`;
    if (!window.confirm(question)) return;
    try {
      if (operation === 'update') {
        const preview = await api(`/api/projects/${encodeURIComponent(managed.folder)}/preview-update`, { method:'POST',data:{ faq:$('manageFaq').value, instructions:$('manageInstructions').value, origins:$('manageOrigins').value.split(/[\n,]/).map(s=>s.trim()).filter(Boolean), revision:managed.revision } });
        if (!preview.diff.changed) throw new Error('Nothing changed.');
      }
      const payload = { mode: operation, folder: managed.folder, revision: managed.revision,
        ...(operation === 'restore' ? { versionId } : { faq:$('manageFaq').value, instructions:$('manageInstructions').value, origins:$('manageOrigins').value.split(/[\n,]/).map(s=>s.trim()).filter(Boolean) }) };
      const response = await api('/api/jobs', { method:'POST',data:payload });
      jobArea='manage'; activeJobId=response.job.id; lastEventCount=-1;
      activeJobProvider=managed.provider; activeJobWorker=managed.name;
      $('manageConsoleBody').replaceChildren();
      $('manageLiveLinks').hidden=true;
      $('manageTestChat').hidden=true;
      $('manageConsoleStatus').textContent=label+' STARTED';
      $('saveDeploy').disabled=true;
      pollHandle=window.setInterval(updateJob,750);
      void updateJob();
    } catch (err) { setManageError(err.message); }
  }
  async function importProject() {
    setManageError('');
    const sourcePath=$('importPath').value.trim();
    if (!sourcePath) { setManageError('Paste the complete path to your v0.2 generated project.'); return; }
    if (!window.confirm('Copy this Falco project into v0.5? Your original files and Cloudflare Worker will remain untouched.')) return;
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
        for (const event of job.events) logLine(event.message,event.stage==='done'?'success':event.stage==='warning'?'warning':event.stage==='error'?'error':'info',target);
        lastEventCount=job.events.length;
      }
      const finished=['failed','partial','generated','deployed','updated','restored'].includes(job.status);
      if (isManage) $('manageConsoleStatus').textContent=job.status.toUpperCase();
      else consoleStatus(job.status.toUpperCase());
      if (finished) {
        window.clearInterval(pollHandle); pollHandle=null;
        if (isManage) {
          if (job.status==='failed'||job.status==='partial') setManageError(job.error||'Deployment not verified. Review the release log.');
          if (managed) await loadManagedProject(managed.folder,{force:true});
          if (job.url && managed?.name===job.name) { $('manageLiveUrl').href=job.url+'/health'; $('manageLiveLinks').hidden=false; }
          await loadProjects();
        } else {
          busy(false);
          if (job.status==='failed'||job.status==='partial') setError(job.error||'Build failed');
          if (job.url) { $('workerLink').href=job.url+'/health'; $('workerLink').textContent='Open live /health ↗'; $('resultLinks').hidden=false; }
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
  async function checkCloudflare() {
    try {
      const status = await api('/api/cloudflare');
      $('cloudflareDot').className = status.connected ? 'status-light online' : 'status-light offline';
      $('cloudflareState').textContent = status.connected ? 'Cloudflare connected' : 'Cloudflare not connected';
      $('cloudflareSub').textContent = status.connected ? `${status.accounts.length || 'Authenticated'} account${status.accounts.length === 1 ? '' : 's'} via Wrangler` : 'Run npx.cmd wrangler login';
      if (status.selectedAccount && !$('accountId').value) $('accountId').value = status.selectedAccount;
      populateCloudAccounts(status);
    } catch {
      $('cloudflareDot').className = 'status-light offline';
      $('cloudflareState').textContent = 'Cloudflare status unknown';
      $('cloudflareSub').textContent = 'Check Wrangler installation';
    }
  }
  async function loadExample() {
    switchMode('create');
    try {
      const example = await api('/api/example/gallinas');
      for (const key of ['business','name','origin','faq','instructions']) $(key).value = example[key];
      userEditedName = true;
      lastAutoName = example.name;
      form.querySelector('input[name="provider"][value="mock"]').checked = true;
      selectedProviderChanged();
      updateSummary();
      setError('');
      $('sectionIdentity').scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' });
    } catch (err) { setError(err.message); }
  }
  async function importText(key, input) {
    const file = input.files?.[0];
    if (!file) return;
    const max = key === 'faq' ? 24000 : 12000;
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
      $('testReply').textContent = `Falco: ${data.reply}`;
    } catch (err) { $('testReply').textContent = err.message; }
    finally { button.disabled = false; }
  }
  async function manageTestChat() {
    if (!managed || !activeJobId || activeJobWorker!==managed.name) return;
    const question=$('manageTestMessage').value.trim();
    if (!question) return;
    if (activeJobProvider !== 'mock' && !window.confirm('This sends a REAL AI request and may use your provider quota. Continue?')) return;
    const button=$('manageTestSend'); button.disabled=true;
    $('manageTestReply').textContent='Contacting your deployed Worker...';
    try {
      const reply=await api(`/api/jobs/${activeJobId}/chat`,{method:'POST',data:{message:question}});
      $('manageTestReply').textContent='Falco: '+reply.reply;
    } catch(err) { $('manageTestReply').textContent=err.message; }
    finally { button.disabled=false; }
  }
  function listen() {
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
    $('saveDeploy').addEventListener('click', () => void startManageJob('update'));
    $('discardChanges').addEventListener('click', () => { if (managed) { $('manageFaq').value=managed.faq; $('manageInstructions').value=managed.instructions; $('manageOrigins').value=(managed.origins ?? [managed.origin]).join('\n'); updateManageDiff(); } });
    $('importBtn').addEventListener('click', importProject);
    $('manageTestToggle').addEventListener('click', () => { $('manageTestChat').hidden=!$('manageTestChat').hidden; });
    $('manageTestSend').addEventListener('click', manageTestChat);
    $('manageTestMessage').addEventListener('keydown', e => { if(e.key==='Enter'){e.preventDefault();void manageTestChat();} });
    $('testChatBtn').addEventListener('click', () => { $('testChat').hidden = !$('testChat').hidden; });
    $('sendTestBtn').addEventListener('click', testChat);
    $('testMessage').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void testChat(); } });
    form.addEventListener('submit', event => event.preventDefault());
    const steps = Array.from(document.querySelectorAll('.step-pill'));
    const observer = new IntersectionObserver(entries => {
      const inView = entries.filter(x => x.isIntersecting).sort((a,b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!inView) return;
      const index = ['sectionIdentity','sectionIntelligence','sectionLaunch'].indexOf(inView.target.id);
      if (index >= 0) steps.forEach((s, i) => s.classList.toggle('current', i === index));
    }, { rootMargin: '-20% 0px -55% 0px', threshold: [0, .1, .3] });
    for (const id of ['sectionIdentity','sectionIntelligence','sectionLaunch']) observer.observe($(id));
  }
  async function init() {
    listen();
    updateSummary();
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
