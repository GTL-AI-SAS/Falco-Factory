# Falco Factory Studio v1.1 — Client Actions MVP

**Baseline:** the user-certified **Falco Factory v1.0**, formerly packaged as v0.8. This release does not replace the knowledge storage architecture or redesign the neutral widget.

## Scope

This is a deliberate **client-only, low-risk** feature. Gemini/OpenAI may propose an allowed action, but **cannot execute it**. A website can register a handler for an action it already supports. Use case #1: `demo.open` changes existing Gallinas tabs 01/02/03.

### Changes
- Optional JSON action registry in **Create New** and **Manage Existing** (presets for Gallinas; `[]` disables actions).
- Action manifest is published as the small non-secret `CLIENT_ACTIONS_JSON` Cloudflare Worker plain-text binding (max 3.9 KB).
- The `/chat` API remains `{reply}` with an OPTIONAL `action:{id,params}`. Existing widgets remain compatible.
- Gemini action mode requests JSON responses; Worker checks ID and exact enum parameters, strips invalid action requests, never runs code.
- OpenAI action mode requests JSON; same strict Worker validation. Mock remains zero-cost chat-only.
- Exported frontend kit includes `ACTIONS_MANIFEST.json` verified from deployed Cloudflare bindings, `actions/action-controller.js`, `actions/actions.manifest.js`, `ACTION_INTEGRATION_GUIDE.md`, and the Gallinas adapter example.
- Integration agent MUST mount one Falco in the parent page for three iframe demos, register the page's own tab click behavior, and deliver `ABRIR_DEMO.cmd` for HTTP local preview.
- Managed updates: v1.0 Workers get a source/runtime upgrade ONLY when enabling actions; upgraded source and prior configuration are backed up. Upgrades of customized/unknown runtime code are refused. URL, name and API secret are preserved.
- Version history restores old action manifests as well as knowledge/origins.

## How to enable Gallinas without creating a new Worker

1. Keep the old v0.2/v1.0 source folder on disk. Close the prior Studio window and launch v1.1 using `ABRIR_FALCO_STUDIO.cmd`.
2. **Manage Existing → falco-gallinas-gemini → Load Worker**. Link to old source automatically if needed.
3. Under **Client actions**, click **Use Gallinas navigation preset (01 / 02 / 03)**.
4. Review JSON, then **Save & Deploy Changes**. **No new API key needed.** This redeploys only the known Worker source, preserving its URL and existing secret.
5. **Export frontend kit ↓** again. Verify `ACTIONS_MANIFEST.json` lists `demo.open` and exactly options 01, 02, 03.
6. Give this ZIP to the website agent. The agent must register `demo.open` in the **parent** webpage using its existing tab handler. It cannot simply drop a kit without wiring the action.
7. Test from `http://localhost:3000` or your deployed HTTPS origin, NOT `file://`.

**Live Cloudflare deployment is not performed by the build environment.** Tests only validate local generation, simulated deploys and action response parsing. The user must do an actual deployment and end-to-end Gemini chat check from their PC.

## Limitations

- Up to **8 actions**; at most **3 string-enum parameters** per action; action manifest <= 3.9 KB.
- All operations are in the local frontend, with exact declared parameter values; no API call, booking, cancellation, payment, file access, DOM selector generation or privileged action.
- The LLM may occasionally return an invalid JSON response; Worker returns a safe provider error instead of executing anything.
- CORS is not authorization; Cloudflare rate limiting remains active.
