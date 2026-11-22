# Falco Factory v1.3 — Optional Cloudflare KV Knowledge

**GTL AI · 21 November 2026**

v1.3 is a backward-compatible, opt-in implementation of **ADR-001 Stage B**.
It does **not** implement Stage C selective retrieval or Stage D RAG.

## Features

- Default knowledge mode remains **Embedded**. Existing Falco Workers continue to work with no KV costs or migration.
- A new Worker can select **Cloudflare KV** in Create New or pass `--knowledge-mode kv` to CLI. Factory provisions one namespace per Worker using **Wrangler**, uploads the knowledge to key `knowledge:active`, binds it, and then deploys the Worker. The initial FAQ and instructions are *not* embedded in Worker source.
- **Manage Existing → Enable KV knowledge** migrates an existing official v1.2 / v1.3 embedded Worker, after a source fingerprint check and a local backup. Factory creates and writes KV *before* deploying KV-aware code. The Worker name, URL, provider API secret, actions and allowed website origins remain unchanged.
- **Save & Deploy Changes** in KV mode publishes FAQ/instructions to KV **without redeploying Worker code** when those are the only fields changed. Changes to origin allowlists or Client Actions still require a Worker deploy.
- **Repair / republish KV** explicitly republishes the current local knowledge and deploys the runtime; use after a partial cloud operation.
- Existing local version history and restore continue to work. Restore of KB-only history in KV mode publishes the selected contents to KV.
- Missing or malformed KV content returns a safe `503 knowledge_unavailable` with a request ID, never silently falling back to stale or bundled text.

## How to use on Windows

1. Keep your v1.2 folder and the original `falco-gallinas-gemini` project. Extract v1.3 to a **different** folder.
2. Double-click `ABRIR_FALCO_STUDIO.cmd`.
3. Open **Manage Existing** and click **Load Worker** for `falco-gallinas-gemini`.
4. If the embedded KB is still small, **do nothing** — embedded is still recommended for restaurants.
5. When the ADR-001 Stage B criteria apply, click **Enable KV knowledge**, review the warning and confirm. Check its deployment console and test `/chat`.
6. Edit FAQ/instructions and click **Save & Deploy Changes**. KV-only edits won't redeploy Worker code. Changes may take time to propagate globally.

For a *new* Worker, choose **Cloudflare KV** in the Create New form. Other CLI flags remain unchanged:

```powershell
npm.cmd run falco:new -- `
  --name falco-example-kv `
  --business "Example Restaurant" `
  --provider mock `
  --knowledge-mode kv `
  --faq .\examples\gallinas\faq.md `
  --deploy
```

## Constraints and security

- Embedded limits: FAQ **24 KB** and instructions **12 KB** (UTF-8). KV MVP: FAQ **96 KB** and instructions **24 KB**, a deliberately bounded input size that is *not* a Cloudflare KV storage limit.
- KV is eventually consistent. New information may take around a minute or longer to propagate to every edge location; don't use KV for live inventory, payments or reservation state.
- The Worker reads **one KV key on each `/chat` call**, creating KV reads and sending *all loaded knowledge* to Gemini/OpenAI. This does not decrease model tokens. For a large corpus, ADR-001 Stage C selective retrieval is required before scaling further.
- KV Free limits apply to the whole Cloudflare account, not individually to each Worker. Confirm your current Cloudflare plan and quotas.
- The local editable `.falco-knowledge.json` file is gitignored. It holds business text, **not passwords or API keys**. Keep your local project backups secure; do not publish sensitive instructions to a frontend repository.
- You need Workers deploy permissions **and Workers KV Storage Write** permission for create/upload. Wrangler OAuth login may already provide the necessary scopes. For CI use appropriately scoped API tokens.
- KV namespace deletion is **never automatic**, even if Worker creation or migration fails. A partial failure can leave an unused namespace; inspect the Cloudflare dashboard before cleanup.
- The generated frontend integration ZIP does not receive KV values or secrets; it continues to call the public `/chat` contract.
- Dry-run does not create namespaces or cloud resources. `Generate files` without `Deploy` does not provision KV; prefer Factory's deployment flow to do both.
- `--force` is not a storage migration mechanism. Use **Enable KV knowledge** for an existing Worker.

## Diagnosis and recovery

- The local Studio release console distinguishes namespace creation, KV upload, code deployment and health verification.
- If namespace creation or upload fails **before** code migration, the old Worker stays deployed with its embedded knowledge. The local job may still be marked partial because a namespace or snapshot may exist.
- If code deploy fails **after** local files were switched to KV, the project is recoverable via **Repair / republish KV**. Do not delete the original version backups.
- `GET /health` remains a health check without an external KV read. For a real readiness check, test `POST /chat` (Mock mode does so automatically in the initial deployment verification).

## Sources

- https://developers.cloudflare.com/kv/get-started/
- https://developers.cloudflare.com/workers/wrangler/commands/kv/
- https://developers.cloudflare.com/kv/concepts/how-kv-works/
- https://developers.cloudflare.com/kv/platform/pricing/
- https://developers.cloudflare.com/fundamentals/api/reference/permissions/

See `GTL_AI_Falco_Knowledge_Architecture_ADR_001.md` for GTL AI's suggested transition thresholds.
