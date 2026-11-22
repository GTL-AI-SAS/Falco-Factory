# Upgrade to Falco Factory v1.6.3

## Preserve existing local Workers

The safest upgrade is to extract v1.6.3 into a new folder.

1. Extract `GTL_AI_Falco_Factory_v1.6.3.zip`.
2. Copy the old Factory root's `.generated` folder into the new Factory root. Each generated Worker folder contains its local source, snapshots, and `.falco-deployments.json` baseline.
3. Optionally copy `.falco-operations` if you want to retain the local operation history.
4. Do not copy `node_modules`. Run `npm.cmd ci` in the new folder.
5. Open `ABRIR_FALCO_STUDIO.cmd`.

Wrangler authentication is global to the Windows user profile; do not copy Wrangler credential files into the project.

## Use deployment verification

### Chat check

In Create New or Manage Existing, enable **Authorize one live chat request**. This sends one `/chat` request after deployment and may incur provider charges.

### Client Action proposal check

When at least one Client Action is configured and the provider is Gemini or OpenAI:

1. Enable **Verify the first configured Client Action**.
2. Enter a natural-language message that should trigger the first configured action.
3. Save & Deploy or use **Check live Worker**.

This is explicit authorization for one provider request. That same request verifies both the chat reply and the action proposal; selecting both chat and action checks does not make two calls.

The test uses the first configured action and the first allowed enum value for each parameter. It inspects the JSON proposal only. It does not execute the website's registered action handler or perform navigation.

Mock mode can test health, CORS, and its fixed chat response without provider charges, but it cannot generate Client Action proposals. Studio disables the action proposal option for Mock and reports `unsupported_provider` when appropriate.

## Verification statuses

- `pass`: the check ran and succeeded.
- `failed`: the check ran and failed.
- `skipped`: a prerequisite failed before the check could run.
- `not_configured`: the feature is not configured.
- `not_authorized`: the check is available but no live provider request was authorized.
- `unsupported_provider`: the selected provider cannot produce the requested check.

No live Cloudflare deployment or paid provider request was performed during the local v1.6.3 validation.
