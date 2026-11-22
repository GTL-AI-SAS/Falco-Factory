# Falco Factory v1.6.3

Falco Factory crea y administra un Worker Cloudflare por negocio. Studio incluye gestión de versiones locales y remotas, controles de consumo y exportación de kits de integración.

Studio uses the supplied [`FALCO_Option_04_Assets`](./assets/brand/FALCO_Option_04_Assets/) identity: official logo and emblem, Mint `#68E2C3`, Near Black `#090B0F`, and Off White `#F3F4F6`. The deployed UI assets are bundled under `ui/assets`. On Windows, use `Falco Studio.exe`: it embeds the official icon and has no shortcut arrow. It opens `main.cmd` from the same folder (or the legacy `ABRIR_FALCO_STUDIO.cmd`), so the complete Factory folder can be moved together. Build it with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-studio-launcher.ps1`; running the CMD also creates it if missing. This uses the Windows .NET Framework compiler and does not change file associations or shortcut overlays.

The EXE runs Studio without a visible terminal. Startup output is saved to `.falco-operations/studio-launcher.log`; startup failures display a message pointing to that log. Closing the last Studio browser tab stops the local server after a short grace period, allowing reloads and waiting for any active deployment or management operation to finish. Other open Studio tabs keep it running. For a persistent development server, use `npm.cmd run falco:ui -- --no-open`; add `--exit-on-close` to enable browser-managed shutdown with a manually opened browser.

Studio plays distinct, clearly audible cues when a Cloudflare account or Falco finishes loading, an operation completes, or a chat reply arrives. Validation errors, failed requests, and partial or failed operations have their own cues. Use **Sounds on/off** in the sidebar to mute them; this preference is remembered in the browser. Sounds are synthesized locally and require a user interaction first. Account changes and manual refreshes play a connection cue; routine background refreshes of the same account stay silent.

Loading a linked Worker now refreshes its deployed settings, Client Actions, and exact Embedded or active KV knowledge before opening the editor. This prevents an older local project from replacing live configuration during an action-only edit. Studio saves a local snapshot before replacing stale files and records the deployment baseline without redeploying. If the deployed knowledge cannot be recovered exactly, loading reports an error and keeps the local files. Restart Studio and reload the browser after updating the Factory source.

## Project directories

- [`docs/releases/`](./docs/releases/): release notes for each version.
- [`docs/upgrades/`](./docs/upgrades/): upgrade guides.
- [`docs/architecture/`](./docs/architecture/): architecture decisions and technical reference.
- [`assets/brand/`](./assets/brand/): original FALCO identity assets and brand guidelines.
- `ui/`: Studio interface and the assets served by its local server.
- `bin/`, `lib/`, `scripts/`: command entry points, application logic, and launch/build tools.
- `templates/`, `frontend-kit-template/`, `examples/`: Worker templates, website integration kit, and examples.
- `tests/`: automated tests and fixtures.
- `.generated/`, `.falco-operations/`: local Worker projects, snapshots, and operation history.


## v1.6.3 — Wrangler 4.166.0 and secure authentication

- Wrangler is pinned to **4.166.0**. This release requires **Node.js 22.12.0 or newer**.
- This package includes the verified lockfile for the pinned Wrangler release. Use `npm ci` to install the locked dependencies. Generated Worker projects receive their own Wrangler lockfile.
- Run `npm.cmd run falco:auth:status` to inspect the active authentication method, credential-storage classification, account visibility, and read-only Workers-list permission check. Tokens and raw Wrangler output are never returned to Studio.
- Run `npm.cmd run falco:auth:secure` to use the official `wrangler login --use-keyring` flow. On Windows, Wrangler stores the encryption key in Windows Credential Manager and keeps the encrypted OAuth file in its Wrangler config directory. If a legacy plaintext OAuth file exists, Wrangler migrates it during opt-in.
- Studio's **Authentication & permissions** panel displays the same safe diagnostics. It distinguishes read permissions from write permissions: deploy and KV writes are intentionally not tested because diagnostics must not mutate Cloudflare resources.
- **Important:** OS keyring storage protects Wrangler OAuth credentials only. It does not encrypt `CLOUDFLARE_API_TOKEN` environment variables. API-token users must protect the token at its source.

Fresh setup (PowerShell):

```powershell
npm.cmd ci
npm.cmd run falco:auth:secure
npm.cmd run falco:auth:status
npm.cmd run falco:doctor -- --cloud
npm.cmd test
```

Local validation: `node --test ./tests/*.test.mjs` — **129 tests passed**. The release has not been authenticated or deployed against a customer's Cloudflare account as part of local validation. Run the diagnostics and a staging deployment from the target Windows machine before production changes.


## v1.6.3 — explicit deployment verification

- Deployment verification now reports `pass`, `failed`, `skipped`, `not_configured`, `not_authorized`, or `unsupported_provider` rather than collapsing every unrun check into `skipped`.
- Health and CORS checks remain automatic. Paid provider requests are never made unless the user explicitly authorizes a chat check or a Client Action proposal check.
- **Create New:** `Authorize one live chat request after deployment` runs one `/chat` request after deploy. The optional Client Action check can use that same single request to verify both the chat response and the first configured action.
- **Manage Workers:** the same optional checks are available for Save & Deploy and Check live Worker.
- A Client Action test requires Gemini or OpenAI, a configured action, and a user-supplied test message. It checks the proposed `{ id, params }` response only; it never invokes the website's registered action handler.
- If an action is configured but not tested, Studio reports `not_authorized`. If no actions exist, it reports `not_configured`. Mock can verify health, CORS and its fixed chat response without cost, but does not generate Client Action proposals.
- If a test is attempted and the provider fails or proposes the wrong action, Studio reports `failed` and marks verification incomplete. The deployment itself is not rolled back automatically.


- **Windows:** extrae el ZIP completo y abre `Falco Studio.exe` o `main.cmd`. Requiere Node.js 22.12.0 o superior.
- **Terminal:** en una extracción nueva ejecuta `npm ci`, después `npm run falco:doctor` y `npm run falco:ui`. En reinstalaciones posteriores puedes usar `npm ci`. Studio abre en `http://127.0.0.1:4317`.
- **Workers existentes:** `Manage Workers → Load Worker → Releases, provider & operations → Review remote state`.
- **Pruebas:** `npm test`, `npm run test:browser` y el smoke opcional de staging descrito en las notas.

[Notas de v1.6 y correspondencia con el roadmap](./docs/releases/RELEASE_NOTES_v1.6.md) · [Referencia de v1.3](./docs/releases/RELEASE_NOTES_v1.3.md) · [ADR de conocimiento](./docs/architecture/GTL_AI_Falco_Knowledge_Architecture_ADR_001.md).

Las instrucciones a continuación se conservan como referencia histórica. Para instalar o administrar esta versión, usa las instrucciones anteriores y las notas de v1.6.

---

# Falco Factory v1.2 — Previous Release Notes (Preserved)

**GTL AI baseline:** the previously released v0.8 is called v1.0; v1.1 introduced Client Actions. This release adds safer error handling without changing action IDs, the `/chat` success contract, or the Worker URL.

## Upgrade Gallinas y Valientes (existing Gemini Worker)

1. Keep your **v1.1 Factory folder** and its generated `.generated/falco-gallinas-gemini` project. Do not delete your existing project source.
2. Extract v1.2 into a **new folder**, double-click `ABRIR_FALCO_STUDIO.cmd`, and authenticate with Wrangler if needed.
3. **Manage Workers** → `falco-gallinas-gemini` → **Load Worker**. Studio should auto-link the v1.1 local source.
4. Review the **Runtime diagnostics v1.2** panel. Click **Upgrade runtime & deploy** and explicitly confirm. This operation only supports official v1.1 source fingerprints. A customized file requires manual review.
5. Factory creates a local `.falco-history/<ID>.runtime-source` backup of every replaced runtime module, checks the existing Cloudflare Worker, redeploys in place and verifies `/health` including `runtimeVersion: "1.2.0"`. If a cloud deploy was partial, the button permits redeploying the already-updated local source.
6. Use **Test /chat**: ask “Muéstrame la opción 03”. If Gemini returns an error, Studio now displays `providerStatus`, a stable error code and a non-secret diagnostic request ID. The same ID appears in safe `wrangler tail` logs.

**No API key is needed to upgrade:** the existing `GEMINI_API_KEY` Cloudflare secret remains untouched. A successful `/health` is not proof Gemini will answer—use the real `/chat` test after deployment. Live deployment requires your local Cloudflare session and has not been performed as part of these local tests.

### Error codes (safe to share)

| Failure | Falco code | Worker HTTP | What to check |
|---|---|---|---|
| Invalid AI request (upstream 400/422) | `provider_invalid_request` | 502 | Model ID, structured-output options, generated JSON request |
| Invalid API key / access (401/403) | `provider_auth_failed` | 503 | Cloudflare secret, Gemini project permissions |
| Model missing (404) | `provider_model_not_found` | 502 | Accessible model ID in Google AI Studio |
| Quota/rate (429) | `provider_rate_limited` | 503 | Free-tier RPM/RPD limits; optional `Retry-After` |
| Provider server failure (5xx) | `provider_upstream_unavailable` | 503 | Provider status and service health |
| Network error / timeout | `provider_unavailable` / `provider_timeout` | 502 / 504 | Network / provider latency |
| Malformed or empty response | `provider_invalid_response` / `provider_empty_response` | 502 | JSON output, model behavior |
| Truncated / safety blocked | `provider_output_truncated` / `provider_blocked` | 502 / 422 | Output token budget, model safety response |

Example v1.2 error (illustrative, no live provider request made):

```json
{"error":"provider_invalid_request","message":"El proveedor rechazó la solicitud. Revisa el modelo y las opciones de generación.","requestId":"00000000-0000-4000-8000-000000000000","retryable":false,"providerStatus":400}
```

**Privacy:** Worker logs are restricted to event, ID, provider, safe error code, upstream HTTP status and fixed reason; they do not include messages, FAQ content, upstream body, API keys or exception stacks. Never post secrets or entire chat payloads to debug a provider failure.

**Cost control:** no automatic AI retries; this prevents silently consuming more of Gemini's free quota. CORS and the per-IP rate-limit binding are unchanged. Existing clients continue receiving `{reply}` and optional validated `{action}` on success. A v1.2 frontend kit interprets errors but **does not resolve** provider API errors by itself.

Official references: [Cloudflare safe logging guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) · [Cloudflare wrangler tail](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/) · [Gemini REST API](https://ai.google.dev/api/generate-content).

---

# GTL AI — Falco Factory Studio v1.1 (Client Actions MVP)

**Cloudflare Worker Factory + Lifecycle Manager + Neutral Frontend Kit + Optional Client Actions**

**v1.1 release notes:** [RELEASE_NOTES_v1.1.md](./docs/releases/RELEASE_NOTES_v1.1.md). This builds on the confirmed v1.0 baseline (previously called v0.8).

v1.0 builds on v0.7 and adds required Windows launchers and a mandatory agent handoff contract to every frontend ZIP. v0.7 added **multiple allowed website origins per Worker**, editable in Create and Manage, plus **verified CORS metadata inside every frontend ZIP**. It retains create/deploy, discovery, one-click load, knowledge edits, local snapshots, delete and design-neutral kit export.

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

**Every website origin must appear in the Worker allowlist.** New Workers use JSON string `ALLOWED_ORIGINS` plus legacy `ALLOWED_ORIGIN` for compatibility. A Worker created in v0.6 with `http://localhost:3000` still blocks GitHub/Cloudflare Pages until you add the published HTTPS origin under **Manage Workers → Load Worker → Allowed website origins → Save & Deploy Changes**. The first origin update automatically upgrades recognized v0.6 CORS checks without touching the Gemini/OpenAI secret. The original Worker URL stays unchanged. Frontend-only changes never change CORS. Do not disable CORS or embed provider secrets as a workaround. If the host site uses Content Security Policy, it must permit `connect-src` to the Worker endpoint and same-origin JS modules/template fetches. Keep rate limiting enabled: CORS is not authentication against non-browser clients.

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

- `main.cmd` — Windows launcher; `Falco Studio.exe` opens it without a visible terminal.
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


## NEW in v1.1 — Client Actions MVP

Use **Manage Workers → Load Worker → Client actions** to add the Gallinas preset `demo.open` with options 01 / 02 / 03. Click **Save & Deploy Changes** to upgrade your existing Worker without changing its URL or Gemini secret. Then export a fresh frontend ZIP; the action manifest is verified against the deployed Worker binding. The agent must implement the handler in the **website parent page**; see `ACTION_INTEGRATION_GUIDE.md`. Old chat-only clients continue to work. No action is executed without a local handler.

For CLI, add `--actions ./examples/gallinas/actions.json` to the normal `falco:new` command. Use `[]` (default) for chat-only Workers. This release DOES NOT allow bookings, cancellations, user auth, payments, arbitrary URLs or agent-controlled JavaScript.

### Manual Windows diagnostic (no credentials in commands)

```powershell
$body = '{"message":"Quiero ver la tercera opción","history":[]}'
$body | curl.exe -i -X POST "https://falco-gallinas-gemini.gtl-ai.workers.dev/chat" `
  -H "Content-Type: application/json" --data-binary "@-"
```

A v1.2 failure includes a safe `requestId` plus `providerStatus`, so you can distinguish Gemini HTTP 400 from 404 or 429. To correlate with the Worker logs, in a terminal authenticated with the target Cloudflare account run:

```powershell
npx.cmd wrangler tail falco-gallinas-gemini --format pretty
```

**Share only the error code, provider HTTP status and requestId with a developer.** Never publish `GEMINI_API_KEY`, Cloudflare tokens, prompts, booking data, or full provider error bodies. If a Worker returns a valid `/health` but `/chat` still fails, it is not yet functionally validated.
