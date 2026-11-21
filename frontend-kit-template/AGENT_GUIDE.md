# Handoff to the design/integration agent

> **MANDATORY DELIVERY CONTRACT (READ FIRST): `LEER_PRIMERO_AGENTE.md`.**
>
> When handing off an integrated client website, you **MUST provide `ABRIR_DEMO.cmd` at the root of that final website**, not just in the Falco kit. It must launch the complete website over HTTP on `http://localhost:3000/` and open the browser with a double-click on Windows. Never use `file://` to test the integrated widget. For static websites, copy `integration/ABRIR_DEMO.cmd` and `integration/tools/falco-static-server.mjs` from this kit to the site's root and `tools/` folder. For Vite/Next/React, adapt the CMD to launch the real framework dev server on port 3000. See the required checklist in `LEER_PRIMERO_AGENTE.md`.

You are receiving Falco's **neutral transport + example presentation**, not a visual design specification. **Your job is to create the best chat interface for the host website.** You may make it editorial, minimal, animated, full-screen, inline, or floating. Do not preserve the demo look unless it serves the site's art direction.

## Client Actions v1.1 — IMPORTANT

**READ `ACTION_INTEGRATION_GUIDE.md` and `ACTIONS_MANIFEST.json` BEFORE CODING.** A client action is a suggestion, never a permission to execute arbitrary JavaScript. Register only local handlers for capabilities the host page already exposes. Gallinas: `demo.open` changes between 01/02/03 using its existing tabs, with one global Falco in the parent page; never duplicate Falco inside the three iframes. A successful chat reply does not guarantee navigation occurred.

## Ownership boundaries

**YOUR TERRITORY — edit freely:**
- `widget/falco-widget.html` — markup, content hierarchy, data hooks (update selectors together).
- `widget/falco-widget.css` — typography, colors, layout, responsive, motion.
- `widget/falco-widget.js` — event handling, UI state and rendering. Feel free to replace it outright.
- `config/falco.config.js` — public labels, welcome text, *public* Worker endpoint if required.
- Any page-specific React/Vue/Next/HTML integration files you create.

**STABLE TRANSPORT — prefer not to edit:**
- `core/falco-client.js` — sends POST /chat, bounds message/history, handles timeouts and errors.
- Contract and security rules in `API_CONTRACT.md`.

For a bespoke UI, simply import:

```js
import { createFalcoClient } from './core/falco-client.js';
import { falcoConfig } from './config/falco.config.js';
const falco = createFalcoClient({ endpoint: falcoConfig.endpoint });
const { reply } = await falco.send('Hola, ¿qué ofrecen?');
// Render reply safely with textContent, never innerHTML.
```

## Integration checklist

1. **Deliver `ABRIR_DEMO.cmd` at the final website root and test it; this is non-optional.** Read `LEER_PRIMERO_AGENTE.md` before integrating.
2. Keep the original **Worker URL**. Do not call Gemini or OpenAI from the browser.
3. Never place secrets in frontend files, analytics, logs or GitHub.
4. Keep messages as plain text or sanitize any markdown renderer. Never use unsafe `innerHTML` on model output.
5. Preserve keyboard operation, meaningful labels, focus handling and reduced-motion support.
6. Respect mobile viewports, error/loading states, disable duplicate submissions.
7. Read `ALLOWED_ORIGINS.md` before deploying: only the exact listed website origins may call `/chat` from browsers. If the target origin is missing, update Allowed Origins in Factory first, then re-export. Never authorize `Origin: null` or use `*` as a workaround.
8. Test: `/health`, `/chat`, mobile, keyboard, CORS preflight in the browser, timeout, HTTP 429 and malformed messages. A successful curl test does not prove browser CORS works.
9. Keep backend prompt/FAQ edits in **Falco Factory Studio**, not the widget.
10. Include final README instructions for end users: `ABRIR_DEMO.cmd` → `http://localhost:3000/` → keep terminal open. For HTTPS GitHub/Cloudflare Pages, authorize the real published origin separately.

## Framework freedom

You may wrap the client in React, Next.js, Vue or Svelte — the kit itself deliberately uses zero frameworks and needs no bundler. A framework-specific adapter is not necessary to access the API. The **website launcher** must however start the correct development server for that framework.

## Constraints that should never silently change

- Request: `{ "message": "...", "history": [{ "role": "user|assistant", "content": "..." }] }`
- Response: `{ "reply": "...", "action"?: {"id":"...","params":{...}} }` (optional; not auto-executed).
- Maximum user message: 2,000 characters; previous history: 8 entries, 1,000 characters each.
- AI errors are structured as `{ "error": "code" }` with non-2xx status.


## Falco v1.2 — Diagnóstico seguro de errores

`/chat` puede devolver `{ "error": "provider_model_not_found", "message": "...", "providerStatus": 404, "requestId": "UUID", "retryable": false }` con estado HTTP no 2xx. **Nunca renderices cuerpos de error crudos del proveedor ni claves de API.** El frontend puede mostrar el `requestId` y `providerStatus` para soporte técnico; usa `textContent` y evita insertar HTML no confiable. El código de error permite distinguir modelo inexistente, clave rechazada, límite gratuito, timeout, JSON inválido y bloqueo de seguridad. Cuando `retryable` es false no repitas automáticamente la petición; no malgastes cuota de Gemini. Las acciones solamente pueden ejecutarse cuando `/chat` devuelve una respuesta exitosa, válida y verificada por `action-controller.js`.
