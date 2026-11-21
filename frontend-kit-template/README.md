# Falco — Neutral Frontend Integration Kit

> **AGENTE INTEGRADOR: LEE PRIMERO `LEER_PRIMERO_AGENTE.md`.**
> La entrega de la web final **debe incluir `ABRIR_DEMO.cmd` en la raíz** y funcionar con doble clic en Windows. Si la web es estática, copia el launcher ya incluido en `integration/`.

This package is **public frontend code only**. No Gemini/OpenAI API keys or Cloudflare credentials are included. Falco Factory generated the public Worker endpoint and nothing here deploys or alters the Worker.

## Abrir la demo de Falco con UN clic (Windows)

1. Extrae todo el ZIP (no ejecutes archivos desde dentro del ZIP sin extraer).
2. Haz doble clic en **`ABRIR_FALCO_KIT.cmd`** (incluido en la raíz de este kit).
3. Se inicia `http://localhost:3000/` con Node.js 20+; deja abierta la consola mientras lo uses.

Este launcher abre **la demo neutral del kit**, no la web final del cliente. El agente integrador debe entregar **su propio** `ABRIR_DEMO.cmd` al lado de `index.html` de la web terminada. Para sitios HTML estáticos, basta copiar los archivos preparados en `integration/` (ver `LEER_PRIMERO_AGENTE.md`).

Para ejecutar manualmente la demo desde PowerShell, en la raíz del kit:

```powershell
node .\demo\server.mjs
```

La URL debe ser `http://localhost:3000/` (no `file://` ni `127.0.0.1:3000` si este último no está autorizado). El Worker debe permitir ese origen exacto en CORS, de lo contrario la UI puede abrir pero `/chat` fallará.

## Integrate into a website (no dependencies)

Copy `core/`, `widget/`, and `config/` to a static directory served by the website, e.g. `/falco/`.

```html
<link rel="stylesheet" href="/falco/widget/falco-widget.css">
<div id="falco-mount"></div>
<script type="module">
  import { mountFalcoWidget } from '/falco/widget/falco-widget.js';
  mountFalcoWidget('#falco-mount');
</script>
```

An agent may replace the widget completely and import `createFalcoClient` from `core/falco-client.js` into its own design. **A local HTTP server is still necessary to test the final site.** The included `integration/` folder provides a ready-to-copy `.cmd` and secure local static server.

## Generated connection

- Worker: `__WORKER_NAME__`
- Public chat endpoint: `__CHAT_ENDPOINT__`
- Authorized frontend origins at export time (verified from Cloudflare):
__ALLOWED_ORIGINS__

See `ALLOWED_ORIGINS.json` (machine-readable) and `ALLOWED_ORIGINS.md` (integration guide). This is a snapshot; re-export after changing Cloudflare settings.

## Production hosting: GitHub Pages / Cloudflare Pages

Published static sites work via normal HTTPS: **no `.cmd` is needed on the production server**. The `.cmd` is a Windows **local preview launcher**. Before publication, the site agent must ensure its exact published HTTPS origin is in the Worker's allowlist (GitHub Pages **origin excludes repository path**). Do not allow `Origin: null`, disable CORS or expose private Gemini/OpenAI keys. CORS alone does not protect a public API; preserve Worker rate limiting.

If the host site has a Content Security Policy, ensure `connect-src` permits the Worker HTTPS endpoint and scripts/templates load from allowed same-origin sources.

See `LEER_PRIMERO_AGENTE.md`, `AGENT_GUIDE.md`, and `API_CONTRACT.md` before changing anything.
