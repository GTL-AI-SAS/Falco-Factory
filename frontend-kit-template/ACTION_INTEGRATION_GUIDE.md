# Falco Client Actions v1.1 — Mandatory integration guide

> Client actions are **UI navigation hints**, not agent tools or administrative powers. The browser executes **only functions expressly registered by the website developer**. Actions never execute inside the Cloudflare Worker, never call arbitrary URLs and never receive user credentials.

## 1. Examine `ACTIONS_MANIFEST.json`

This file is verified against Cloudflare's **deployed** `CLIENT_ACTIONS_JSON` plain-text binding during export. `actions: []` means chat-only. Never invent client-side actions that aren't declared.

A proposed chat result may include `action`:

```json
{"reply":"Te llevo a la opción 02.","action":{"id":"demo.open","params":{"option":"02"}}}
```

`action` is OPTIONAL. Older clients still work by ignoring it. It is a suggestion, not proof that navigation occurred.

## 2. Register only functions already supported by the website

```js
import { createActionController } from './actions/action-controller.js';
import { falcoActions } from './actions/actions.manifest.js';
const controller = createActionController(falcoActions, {
  'demo.open': ({ option }) => {
    const tab = document.getElementById('tab-' + option);
    if (!tab) return { ok: false };
    tab.click(); // Reuses existing tab handler.
    return { ok: true };
  }
});
// After receiving an actual Falco response:
if (result.action) await controller.dispatch(result.action);
```

Adjust the example to the real page. For Gallinas with three iframe previews, **mount one global Falco in the parent page**, and register the action handler in the parent page so the chat history persists. See `integration/gallinas-actions.example.js`.

The neutral widget accepts `actionHandlers`:

```js
mountFalcoWidget('#falco-root', {
  actionHandlers: { 'demo.open': ({option}) => { /* actual existing tab logic */ } }
});
```

Without a handler, Falco can explain the options but **does not navigate**; the widget displays a non-destructive status. The model does not receive permission to choose a selector, run JavaScript or execute a URL.

## 3. Mandatory checks before delivery

- [ ] Action ID and parameter enums match `ACTIONS_MANIFEST.json`.
- [ ] Invalid IDs, unknown options and extra fields are rejected (no effect).
- [ ] Page navigation uses the same tab/button behavior as manual clicks.
- [ ] Chat persists across all three Gallinas options; no per-iframe copies.
- [ ] Asking an unrelated question does NOT change tabs.
- [ ] Missing handler fails safely; do not silently claim successful navigation.
- [ ] The result uses the established accessible widget conventions.
- [ ] `ABRIR_DEMO.cmd` works from the FINAL website root over `http://localhost:3000/`.
- [ ] Production origin is listed in `ALLOWED_ORIGINS.json`.
- [ ] No API key, Worker secret, eval(), arbitrary URL, injected HTML, or privileged delete/booking action.

## Architecture constraints

For v1.1, only client-side, *low-risk*, reversible operations with **closed string enum parameters** are supported. Any action that writes records, books a table, cancels a booking, charges money or authenticates a user is **out of scope**. Implement separately later with explicit authorization, confirmation and idempotency.

The Worker does not verify whether the site actually performed the operation. Client-side UI state remains the source of truth; the agent's text must not promise execution as a fact.
