/* Non-secret connection metadata only. All Wrangler work runs on the local server. */
export function createConnectionsUi({ api, getProject, onAssigned, onRemoteChange, onDiagnostics }) {
  const $ = id => document.getElementById(id);
  const cache = new Map();
  let connections = [];
  let editing = null;
  let polling = false;
  const selectors = ['createAuthProfile','remoteAuthProfile','managedAuthProfile','authConnectionSelect'];
  const label = profile => connections.find(c => c.authProfile === (profile || ''))?.name || profile || 'Legacy default';
  const mask = id => id ? id.slice(0, 6) + '…' + id.slice(-4) : 'Not selected';
  const notice = message => { $('connectionNotice').textContent = message; };
  const option = (value, text) => { const el = document.createElement('option'); el.value = value; el.textContent = text; return el; };
  const open = () => { $('connectionManager').hidden = false; $('connectionManager').scrollIntoView({ block: 'start', behavior: 'smooth' }); };
  const action = (text, run) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn ghost compact'; button.textContent = text;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await run(); } catch (error) { notice(error.message); }
      finally { button.disabled = false; }
    });
    return button;
  };
  function fillAccounts(selectId, profile, chosen = '') {
    const select = $(selectId);
    const accounts = cache.get(profile)?.accounts || [];
    select.replaceChildren(option('', accounts.length > 1 ? 'Select an account explicitly' : 'Select an account'));
    for (const account of accounts) select.append(option(account.id, `${account.name} · ${mask(account.id)}`));
    if (chosen && !accounts.some(a => a.id === chosen)) select.append(option(chosen, `Saved account · ${mask(chosen)} (verify access)`));
    select.value = chosen || (accounts.length === 1 ? accounts[0].id : '');
  }
  function updateTarget() {
    const profile = $('createAuthProfile').value;
    const accountId = $('accountId').value.trim();
    const status = cache.get(profile);
    const account = status?.accounts?.find(a => a.id === accountId);
    $('deploymentTarget').textContent = `Deployment target: ${label(profile)} · ${account?.name || mask(accountId)}. Authentication: ${status?.factoryCompatible && account ? 'verified' : 'verify connection'}. Workers read: ${status?.selectedAccount === accountId && status?.permissions?.workersRead?.status === 'passed' ? 'confirmed' : 'not checked for this account'}. Deployment write: untested.`;
  }
  function populateSelectors() {
    for (const id of selectors) {
      const select = $(id), chosen = select.value;
      select.replaceChildren(...connections.map(c => option(c.authProfile, c.name + (c.available ? '' : ' (unavailable)'))));
      if (chosen && !connections.some(c => c.authProfile === chosen)) select.append(option(chosen, chosen + ' (unavailable)'));
      select.value = chosen;
    }
    updateTarget();
  }
  function render() {
    const cards = $('connectionCards'); cards.replaceChildren();
    const statuses = { connected: 'Connected', 'authentication-expired': 'Authentication expired', 'authentication-failed': 'Authentication failed',
      'secure-storage-unavailable': 'Secure storage unavailable', 'account-access-denied': 'Account access denied',
      'profile-unavailable': 'Wrangler profile unavailable', 'environment-override': 'Environment token overrides profiles' };
    for (const connection of connections) {
      const profile = connection.authProfile, status = cache.get(profile);
      const card = document.createElement('article'); card.className = 'connection-card';
      card.classList.toggle('connection-healthy', status?.status === 'connected');
      const title = document.createElement('h3'); title.textContent = connection.name;
      const state = document.createElement('strong'); state.className = status?.status === 'connected' && status.factoryCompatible ? 'auth-good' : 'auth-warn';
      state.textContent = !connection.available ? statuses['profile-unavailable'] : statuses[status?.status] || 'Not verified';
      const info = document.createElement('p'); info.textContent = `${profile ? 'Profile: ' + profile : 'Legacy default authentication'} · ${status?.authMethodLabel || 'Authentication not checked'}${status?.identity ? ' · ' + status.identity : ''}`;
      const storage = document.createElement('p'); storage.textContent = status?.credentialStorageLabel || 'Secure storage not verified';
      const checked = document.createElement('small'); checked.textContent = 'Last successful verification: ' + (connection.lastVerifiedAt ? new Date(connection.lastVerifiedAt).toLocaleString() : 'Never');
      card.append(title, state, info, storage, checked);
      if (status?.recommendation && !status.factoryCompatible) { const p = document.createElement('p'); p.textContent = status.recommendation; card.append(p); }
      const accounts = document.createElement('ul');
      for (const account of status?.accounts || []) {
        const li = document.createElement('li'); li.textContent = `${account.name} · ${mask(account.id)}${connection.defaultAccountId === account.id ? ' · Default' : ''} `;
        li.append(action('Copy ID', async () => { await navigator.clipboard.writeText(account.id); notice('Account ID copied.'); })); accounts.append(li);
      }
      card.append(accounts);
      const projects = document.createElement('p'); projects.textContent = 'Assigned projects: ' + ((connection.projects || []).map(p => p.name).join(', ') || 'None'); card.append(projects);
      const inaccessible = status?.connected ? (connection.projects || []).filter(p => p.accountId && !status.accounts.some(a => a.id.toLowerCase() === p.accountId.toLowerCase())) : [];
      if (inaccessible.length) {
        const warning = document.createElement('p'); warning.className = 'auth-bad';
        warning.textContent = 'Account access denied for: ' + inaccessible.map(p => p.name).join(', ') + '. Reauthorize the missing accounts or explicitly change those project assignments.';
        card.append(warning); card.classList.remove('connection-healthy');
      }
      const actions = document.createElement('div'); actions.className = 'connection-actions';
      actions.append(action('Verify', () => verify(profile)), action('Manage', () => edit(connection)), action('Reauthenticate', () => authenticate(profile, connection.name)));
      if (profile) actions.append(action('Delete connection', async () => {
        const assigned = (connection.projects || []).map(p => p.name);
        if (!window.confirm(`Remove the local Wrangler profile "${profile}" and all its directory bindings?\n\nAssigned projects: ${assigned.join(', ') || 'None'}. They keep their assignment and will need this profile restored or an explicit connection change.\n\nCloudflare accounts, Workers, KV, deployments, secrets and local projects are retained.`)) return;
        const confirmation = window.prompt('Type the profile name to delete this local connection:', '');
        if (confirmation !== profile) return;
        await api('/api/connections/delete', { method: 'POST', data: { authProfile: profile, confirmation, acknowledge: 'DELETE CONNECTION', projects: assigned } });
        cache.delete(profile); await refresh(); notice('Local connection removed. Remote Cloudflare resources and projects were retained.');
      }));
      card.append(actions); cards.append(card);
    }
  }
  async function verify(profile) {
    const result = await api('/api/connections/verify', { method: 'POST', data: { authProfile: profile } });
    cache.set(profile, result);
    const connection = connections.find(c => c.authProfile === profile);
    if (connection && result.factoryCompatible) connection.lastVerifiedAt = result.checkedAt;
    render(); updateTarget();
    return result;
  }
  async function refresh() {
    const data = await api('/api/connections'); connections = data.connections;
    populateSelectors(); render();
    if (data.operation?.status === 'working') void poll();
  }
  async function accountsFor(profile, selectId, chosen) {
    try { if (!cache.has(profile)) await verify(profile); }
    catch (error) { notice(error.message); }
    // A slower response must not reset a selector that the user has since changed.
    const owner = { createAccountSelect: 'createAuthProfile', remoteAccountSelect: 'remoteAuthProfile', managedConnectionAccount: 'managedAuthProfile' }[selectId];
    if (owner && $(owner).value !== profile) return;
    fillAccounts(selectId, profile, chosen);
  }
  async function edit(connection) {
    editing = connection; $('connectionEditor').hidden = false; $('connectionEditorTitle').textContent = 'Manage connection';
    $('connectionName').value = connection.name; $('connectionProfile').value = connection.authProfile; $('connectionProfile').disabled = true;
    $('saveConnection').hidden = false; $('connectionDefaultField').hidden = false;
    await accountsFor(connection.authProfile, 'connectionDefault', connection.defaultAccountId);
    $('authenticateConnection').textContent = 'Reauthenticate in browser';
  }
  async function poll() {
    if (polling) return;
    polling = true; $('connectionProgress').hidden = false;
    try {
      for (;;) {
        const { operation } = await api('/api/connections/operation');
        $('connectionProgressText').textContent = operation?.message || 'Waiting for authentication…';
        if (operation?.status !== 'working') {
          if (operation?.status === 'connected') { cache.delete(operation.authProfile); await verify(operation.authProfile); }
          await refresh(); notice(operation?.message || 'Authentication finished.'); break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) { notice(error.message + ' Refresh connections to check the outcome.'); }
    finally { polling = false; $('connectionProgress').hidden = true; }
  }
  async function authenticate(authProfile, name, newConnection = false) {
    await api('/api/connections/authenticate', { method: 'POST', data: { authProfile, name, newConnection } });
    $('connectionEditor').hidden = true; open(); void poll();
  }
  function bind(id, run) { $(id).addEventListener('click', async () => { try { await run(); } catch (error) { notice(error.message); } }); }
  bind('openConnections', async () => { open(); await refresh(); if (!polling) { notice('Verifying connections…'); await Promise.all(connections.filter(c => c.available).map(c => verify(c.authProfile))); notice('Connection verification completed.'); } });
  bind('closeConnections', () => { $('connectionManager').hidden = true; });
  bind('refreshConnections', async () => { await refresh(); await Promise.all(connections.map(c => verify(c.authProfile))); });
  bind('addConnection', () => {
    editing = null; $('connectionEditor').hidden = false; $('connectionEditorTitle').textContent = 'Add Cloudflare connection';
    $('connectionName').value = ''; $('connectionProfile').value = ''; $('connectionProfile').disabled = false;
    $('connectionDefaultField').hidden = true; $('saveConnection').hidden = true; $('authenticateConnection').textContent = 'Connect in browser'; $('connectionName').focus();
  });
  $('connectionName').addEventListener('input', () => { if (!editing) $('connectionProfile').value = $('connectionName').value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 64); });
  bind('authenticateConnection', () => {
    const name = $('connectionName').value.trim(), authProfile = $('connectionProfile').value.trim();
    if (!name || (!editing && !authProfile)) throw new Error('Enter a connection name and profile name.');
    return authenticate(authProfile, name, !editing);
  });
  bind('saveConnection', async () => { await api('/api/connections/save', { method: 'POST', data: {
    authProfile: editing.authProfile, name: $('connectionName').value.trim(), defaultAccountId: $('connectionDefault').value
  } }); $('connectionEditor').hidden = true; await refresh(); });
  bind('dismissConnectionEditor', () => { $('connectionEditor').hidden = true; });
  bind('cancelConnectionAuth', async () => { await api('/api/connections/cancel', { method: 'POST', data: {} }); notice('Cancelling browser authentication…'); });
  $('createAuthProfile').addEventListener('change', async () => {
    const profile = $('createAuthProfile').value;
    $('accountId').value = ''; $('createAccountSelect').replaceChildren(option('', 'Loading accounts…')); updateTarget();
    await accountsFor(profile, 'createAccountSelect');
    if ($('createAuthProfile').value === profile) { $('accountId').value = $('createAccountSelect').value; updateTarget(); }
  });
  $('createAccountSelect').addEventListener('change', () => { $('accountId').value = $('createAccountSelect').value; updateTarget(); });
  $('accountId').addEventListener('input', updateTarget);
  $('remoteAuthProfile').addEventListener('change', async () => {
    const profile = $('remoteAuthProfile').value;
    $('remoteAccountManual').value = ''; $('remoteAccountSelect').replaceChildren(option('', 'Loading accounts…'));
    await accountsFor(profile, 'remoteAccountSelect');
    if ($('remoteAuthProfile').value === profile) onRemoteChange();
  });
  $('managedAuthProfile').addEventListener('change', () => void accountsFor($('managedAuthProfile').value, 'managedConnectionAccount'));
  $('authConnectionSelect').addEventListener('change', () => { $('authAccountSelect').replaceChildren(option('', 'Loading accounts…')); onDiagnostics(); });
  $('authAccountSelect').addEventListener('change', onDiagnostics);
  bind('saveProjectConnection', async () => {
    const project = getProject(); if (!project) throw new Error('Load a project first.');
    const data = { authProfile: $('managedAuthProfile').value, accountId: $('managedConnectionAccount').value, revision: project.revision };
    if (project.accountId && project.accountId !== data.accountId) {
      if (!window.confirm('Change this project’s account? Its original Worker and KV data remain in the old account. A future deployment creates a separate Worker and KV namespace. An occupied destination name will be refused.')) return;
      data.confirmName = window.prompt('Type the Worker name to confirm the account change:', ''); data.acknowledge = 'RETARGET';
      if (data.confirmName !== project.name) return;
    }
    const result = await api(`/api/projects/${encodeURIComponent(project.folder)}/connection`, { method: 'POST', data });
    $('projectConnectionStatus').textContent = 'Connection and account verified. Local assignment saved; no deployment was made.';
    await onAssigned(result.project); await refresh();
  });
  return { refresh, label, updateTarget,
    async loadProject(project) {
      const profile = project.authProfile || '';
      if (![...$('managedAuthProfile').options].some(o => o.value === profile)) $('managedAuthProfile').append(option(profile, profile + ' (unavailable)'));
      $('managedAuthProfile').value = profile; $('managedConnection').textContent = label(profile);
      await accountsFor(profile, 'managedConnectionAccount', project.accountId);
    },
    receiveDiagnostics(status) {
      const profile = status.authProfile || ''; cache.set(profile, status); render();
      if ($('authConnectionSelect').value === profile) fillAccounts('authAccountSelect', profile, status.selectedAccount || $('authAccountSelect').value);
      if ($('remoteAuthProfile').value === profile) fillAccounts('remoteAccountSelect', profile, $('remoteAccountSelect').value);
      if ($('createAuthProfile').value === profile) { fillAccounts('createAccountSelect', profile, $('accountId').value); if (!$('accountId').value) $('accountId').value = $('createAccountSelect').value; }
      updateTarget();
    }
  };
}
