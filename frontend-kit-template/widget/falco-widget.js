/**
 * EDITABLE PRESENTATION CONTROLLER. Replace the markup and CSS however you wish.
 * Keep the transport (../core/falco-client.js) intact and preserve its API contract.
 * To build a completely custom UI, import createFalcoClient directly (see AGENT_GUIDE.md).
 */
import { createFalcoClient } from '../core/falco-client.js';
import { falcoConfig } from '../config/falco.config.js';
import { createActionController } from '../actions/action-controller.js';
import { falcoActions } from '../actions/actions.manifest.js';

let instanceCount = 0;
export async function mountFalcoWidget(target, overrides = {}) {
  const mount = typeof target === 'string' ? document.querySelector(target) : target;
  if (!(mount instanceof Element)) throw new Error('Falco mount target not found.');
  const config = { ...falcoConfig, ...overrides };
  const templateUrl = new URL('./falco-widget.html', import.meta.url);
  const templateResponse = await fetch(templateUrl);
  if (!templateResponse.ok) throw new Error(`Cannot load Falco HTML template (HTTP ${templateResponse.status}).`);
  const html = await templateResponse.text();
  const holder = document.createElement('template');
  holder.innerHTML = html; // Trusted, same-origin local source file — never user/provider text.
  const root = holder.content.querySelector('[data-falco-widget]');
  if (!root) throw new Error('Missing [data-falco-widget] in falco-widget.html');
  const find = key => {
    const el = root.querySelector(`[data-falco-${key}]`);
    if (!el) throw new Error(`Missing data-falco-${key} hook in HTML template.`);
    return el;
  };
  const panel = find('panel');
  const launcher = find('launcher');
  const close = find('close');
  const form = find('form');
  const input = find('input');
  const messages = find('messages');
  const status = find('status');
  const submit = find('send');
  const lifecycle = new AbortController();
  const id = `falco-panel-${++instanceCount}`;
  const inputId = `falco-input-${instanceCount}`;
  panel.id = id;
  launcher.setAttribute('aria-controls', id);
  input.id = inputId;
  find('input-label').setAttribute('for', inputId);
  find('title').textContent = config.assistantName || 'Assistant';
  find('launch-label').textContent = config.launcherLabel || 'Chat';
  const privacy = root.querySelector('[data-falco-privacy]');
  if (privacy) {
    const { url, notice } = config.privacy ?? {};
    if (typeof notice === 'string' && notice.trim()) privacy.textContent = notice;
    if (url) {
      try {
        const page = new URL(url);
        if (page.protocol === 'https:' && !page.username && !page.password) {
          const link = document.createElement('a');
          link.href = page.href; link.textContent = 'Privacy policy'; link.rel = 'noopener noreferrer';
          privacy.append(document.createTextNode(' '), link);
        }
      } catch { /* A client-provided malformed policy link is discarded. */ }
    }
    privacy.hidden = !privacy.textContent.trim();
  }
  input.placeholder = config.placeholder || 'Write a message';
  const client = createFalcoClient({ endpoint: config.endpoint, timeoutMs: config.timeoutMs, maxHistory: config.maxHistory });
  const actions = createActionController(falcoActions, overrides.actionHandlers ?? {});
  let destroyed = false;
  let busy = false;

  function message(role, content) {
    const el = document.createElement('div');
    el.className = `falco__bubble falco__bubble--${role}`;
    el.textContent = content; // Never inject provider/user text as HTML.
    messages.append(el);
    messages.scrollTop = messages.scrollHeight;
  }
  function setOpen(isOpen) {
    if (destroyed) return;
    panel.hidden = !isOpen;
    launcher.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) input.focus(); else launcher.focus();
  }
  function onKeydown(e) { if (e.key === 'Escape' && !panel.hidden) setOpen(false); }
  async function onSubmit(e) {
    e.preventDefault();
    if (destroyed || busy) return;
    const text = input.value.trim();
    if (!text) return;
    busy = true;
    submit.disabled = true;
    input.disabled = true;
    status.dataset.error = 'false';
    status.textContent = 'Responding…';
    message('user', text);
    input.value = '';
    try {
      const turnstileToken = typeof config.getTurnstileToken === 'function' ? await config.getTurnstileToken() : undefined;
      const { reply, action } = await client.send(text, { turnstileToken, signal: lifecycle.signal });
      if (!destroyed) {
        status.textContent = '';
        if (action) {
          message('assistant', config.actionAttemptMessage ?? 'Voy a intentar realizar la acción solicitada.');
          const result = await actions.dispatch(action);
          if (result.executed && !destroyed) {
            message('assistant', config.actionCompletedMessage ?? 'Acción completada.');
          } else if (!destroyed) {
            status.dataset.error = 'true';
            status.textContent = result.reason === 'handler_missing' ? 'Esta página todavía no tiene conectada esa acción.' : 'No se pudo realizar esa acción desde esta página.';
          }
        } else message('assistant', reply);
      }
    } catch (err) {
      if (!destroyed) {
        status.dataset.error = 'true';
        status.textContent = (err.message || 'No se pudo enviar el mensaje.') + (err.requestId ? ` · Diagnóstico: ${err.requestId}` : '');
      }
    } finally {
      busy = false;
      if (!destroyed) {
        submit.disabled = false;
        input.disabled = false;
        if (status.dataset.error !== 'true') status.textContent = '';
        if (!panel.hidden && (document.activeElement === document.body || root.contains(document.activeElement))) input.focus();
      }
    }
  }
  launcher.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', () => setOpen(false));
  form.addEventListener('submit', onSubmit);
  root.addEventListener('keydown', onKeydown);
  if (config.welcomeMessage) message('assistant', config.welcomeMessage);
  mount.append(root);
  return {
    client,
    root,
    open() { setOpen(true); },
    close() { setOpen(false); },
    destroy() { destroyed = true; lifecycle.abort(); root.remove(); },
  };
}
