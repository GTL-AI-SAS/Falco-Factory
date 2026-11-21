# GTL AI — Falco Factory Studio v0.8

**Cloudflare Worker Factory + Lifecycle Manager + Neutral Frontend Integration Kit**

v0.8 builds on v0.7 and adds required Windows launchers and a mandatory agent handoff contract to every frontend ZIP. v0.7 added **multiple allowed website origins per Worker**, editable in Create and Manage, plus **verified CORS metadata inside every frontend ZIP**. It retains create/deploy, discovery, one-click load, knowledge edits, local snapshots, delete and design-neutral kit export.

## One-click Windows launch

1. Extract **the entire ZIP** to a new directory; keep your old Factory folders until previous projects have been loaded successfully.
2. Close the previous Falco Studio terminal window so port `4317` is free.
3. Double-click `ABRIR_FALCO_STUDIO.cmd`. Node.js 20+ is required. The first launch installs Wrangler through npm if needed.
4. Studio opens `http://127.0.0.1:4317`. Use the same Cloudflare account authenticated with Wrangler.

Alternatively:

```powershell
npm.cmd install
npm.cmd test
npm.cmd run falco:ui
```

## NEW in v0.8: protect every integration from the `file://` trap

The **exported frontend ZIP** now contains:

- `ABRIR_FALCO_KIT.cmd`: one-click launcher of the **neutral kit demo** over `http://localhost:3000/`. Requires Node.js 20+; no npm/Python.
- `integration/ABRIR_DEMO.cmd` and `integration/tools/falco-static-server.mjs`: ready to copy into the **final STATIC client website**, next to its `index.html`, to start that full website over HTTP with one click.
- `LEER_PRIMERO_AGENTE.md`: **mandatory agent handoff contract** requiring a working `ABRIR_DEMO.cmd` in the actual website root and browser+CORS verification.
- Updated `AGENT_GUIDE.md` and `README.md` repeating that requirement.

The final site agent is responsible for delivering **its own** `ABRIR_DEMO.cmd` in the final repository and testing the actual integrated website, **not only the kit demo**. For React/Vite/Next the agent adapts that `.cmd` to the existing development server; the static example will not run those frameworks.

The local launcher is for preview; GitHub Pages/Cloudflare Pages require their published HTTPS origin in the Worker allowlist and do not execute `.cmd` in production. Never allow `Origin: null` or use `Access-Control-Allow-Origin: *` to work around this.

## New: Export a Frontend Integration Kit

1. Open **Manage existing Falco**.
2. Wait for the Cloudflare Worker list (or click **Refresh Workers**).
3. On `falco-gallinas-gemini` click **Export frontend kit ↓**.
4. Your browser downloads `falco-gallinas-gemini-frontend-kit.zip`.
5. Give this ZIP to the agent designing the website, along with its own site source. The ZIP includes the **public /chat Worker URL**, not your provider API key.

**You do not need to Load Worker, import local folders, change the knowledge base or redeploy anything to export the kit.** Cloudflare Workers and secrets are left unchanged. The export does read the selected account's `workers.dev` subdomain using Cloudflare's API. Workers using only a custom domain may need a later custom-endpoint export option; this release targets standard active `workers.dev` Worker URLs.

### Contents of the exported ZIP

```text
core/
  falco-client.js          # STABLE: fetch /chat, bounded history, timeouts, errors
widget/
  falco-widget.html        # EDIT FREELY: semantic HTML and data hooks
  falco-widget.css         # EDIT FREELY: neutral styles and CSS variables
  falco-widget.js          # EDIT FREELY: presentation/event adapter
config/
  falco.config.js          # PUBLIC Worker URL and optional UI texts
demo/
  index.html               # Neutral sample page
  server.mjs               # Minimal local static HTTP server, no dependencies
ABRIR_FALCO_KIT.cmd        # One-click preview of the neutral kit
integration/
  ABRIR_DEMO.cmd           # Copy to the final STATIC website root
  tools/falco-static-server.mjs  # Copy to final website tools/
LEER_PRIMERO_AGENTE.md     # MANDATORY integration delivery contract
AGENT_GUIDE.md             # Dedicated agent handoff instructions
API_CONTRACT.md            # Worker POST /chat contract, limits and error codes
README.md                  # Setup, origin/CORS caveats
```

**Design ownership:** Falco Factory owns the AI provider, secrets, Worker, knowledge and API contract. The website agent owns all frontend composition, markup, CSS, motion and brand. No React or Webpack is required; an agent may use React/Next.js by importing the same `createFalcoClient()`.

**No styling configurator is being added to Factory.** The kit must be convenient to customize from the website itself rather than constrain another agent to selected themes.

## Run the exported kit

Unzip it, open PowerShell **inside the exported kit**, and run:

```powershell
node .\demo\server.mjs
```

Open `http://localhost:3000` in the browser. This uses native JavaScript modules and fetches the separate HTML template: **do not open `demo/index.html` via `file://`**. `demo/server.mjs` listens locally on `localhost` only.

To integrate into the real website, copy `core/`, `widget/`, `config/` into a publicly served `/falco/` directory and add:

```html
<link rel="stylesheet" href="/falco/widget/falco-widget.css">
<div id="falco-mount"></div>
<script type="module">
  import { mountFalcoWidget } from '/falco/widget/falco-widget.js';
  mountFalcoWidget('#falco-mount');
</script>
```

Or let the designer replace all UI markup and call `createFalcoClient({endpoint})` directly.

### Important before a production website goes live

**Every website origin must appear in the Worker allowlist.** New Workers use JSON string `ALLOWED_ORIGINS` plus legacy `ALLOWED_ORIGIN` for compatibility. A Worker created in v0.6 with `http://localhost:3000` still blocks GitHub/Cloudflare Pages until you add the published HTTPS origin under **Manage Existing → Load Worker → Allowed website origins → Save & Deploy Changes**. The first origin update automatically upgrades recognized v0.6 CORS checks without touching the Gemini/OpenAI secret. The original Worker URL stays unchanged. Frontend-only changes never change CORS. Do not disable CORS or embed provider secrets as a workaround. If the host site uses Content Security Policy, it must permit `connect-src` to the Worker endpoint and same-origin JS modules/template fetches. Keep rate limiting enabled: CORS is not authentication against non-browser clients.

The exporter reads `ALLOWED_ORIGINS` (or the old `ALLOWED_ORIGIN`) directly from the **deployed Worker bindings**. It does not guess from local metadata. If Cloudflare cannot verify the settings, export fails with an actionable error rather than producing a misleading origin list. The kit contains no billing details or AI provider secrets. It never embeds Google or OpenAI API calls directly.

## Existing operations retained from v0.5

- Create independent Mock/Gemini/OpenAI Workers with a repeatable project generator.
- Deploy using authenticated Wrangler with existing-name collision protection.
- Find remote Workers in the Cloudflare account; one-click load if source exists in an old local Factory installation.
- Edit FAQ and instructions, save a local version snapshot and redeploy while preserving URL and Worker secrets.
- Delete only an explicitly confirmed selected Falco Worker, preserving local files.

Do not delete your older Factory installations until **Load Worker** has imported the needed editable source. Remote discovery alone cannot reconstruct the original editable business context from arbitrary bundled Worker scripts.

## Security design

- Studio binds to `127.0.0.1` and protects local mutation/export endpoints with an unpredictable session token and origin check.
- Export verifies the Worker exists in the selected Cloudflare account before building a ZIP. It fetches the public account `workers.dev` subdomain with authenticated Cloudflare APIs, without returning authentication tokens to the browser.
- Kit files are loaded from a fixed allowlist of local templates; no arbitrary file paths or user-controlled ZIP entries. ZIP writing is dependency-free.
- Generated frontend code contains only public endpoint URL and generic text; no Worker source code, provider API keys or Cloudflare secrets.
- `core/falco-client.js` limits user messages to 2,000 characters, history to 8 messages with 1,000 characters per entry, and handles HTTP errors/timeouts without logging user content.
- Provider answers and user messages are rendered via `textContent`, never as raw HTML.

## Tests and validation

```powershell
npm.cmd test
```

The automated test suite validates this build, including origin parsing, legacy Worker upgrades, runtime CORS checks, snapshot restore, read-only Cloudflare binding verification, and the existing frontend/client tests. The generated ZIP passed `unzip -t`, the demo HTTP server returned `200 OK` on localhost, and individual modules passed Node syntax checks. The sandbox's Chromium browser was blocked by an administrator policy from navigating to localhost, so interactive browser rendering is **not claimed as verified** in this release. Live Cloudflare account export must also be confirmed on your machine.

## Project structure

- `ABRIR_FALCO_STUDIO.cmd` — Windows launcher
- `ui/` — Create/Manage/Export UI
- `lib/ui-server.mjs` — local API; read-only ZIP export route
- `lib/frontend-kit.mjs` + `lib/zip.mjs` — validated kit export and dependency-free ZIP
- `frontend-kit-template/` — neutral handoff kit source
- `lib/deploy.mjs`, `lib/worker-lifecycle.mjs`, `lib/projects.mjs` — existing Cloudflare/knowledge functionality
- `tests/` — built-in Node.js test runner

GTL AI · Falco Factory Studio v0.8 · November 2026

## v0.7 — Allow multiple websites (without touching provider secrets)

Example allowlist for **Gallinas y Valientes** (replace sample Cloudflare Pages subdomain with the one actually deployed):

```text
http://localhost:3000
https://gtl-ai-sas.github.io
https://gallinas-valientes.pages.dev
```

Do NOT include the GitHub Pages repository path; the browser's Origin contains only scheme + host + optional port. Studio rejects `file://`, `null`, `*`, wildcards, remote HTTP, duplicate entries and paths. Exact HTTPS origins only for hosted sites. Maximum 20.

**Create:** paste one origin per line in the **Allowed website origins** field. **Manage:** load the existing Worker (you may need its older local source on the first upgrade), update the dedicated **Allowed website origins** editor, then **Save & Deploy Changes**. Studio creates a local snapshot before editing and retains the Worker name, URL and secrets.

**Export:** click **Export frontend kit ↓** again after deploying origin changes. The ZIP contains `ALLOWED_ORIGINS.json` and `ALLOWED_ORIGINS.md`, read from Cloudflare's deployed bindings at export time. It is a snapshot, not a live subscription; re-export whenever CORS settings change.

**CLI:** for new deployments, `--origin https://example.com` still works. Or use `--origins "http://localhost:3000,https://gtl-ai-sas.github.io"` to supply multiple exact origins. Use either `--origin` or `--origins`, not both.

**Existing live Workers are never changed by merely launching v0.7 or exporting a kit.** Updating the allowed origins explicitly starts a Wrangler redeployment; the actual cloud deploy must be performed from your authenticated Windows machine.
