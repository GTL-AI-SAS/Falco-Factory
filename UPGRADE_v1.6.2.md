# Upgrade to Falco Factory v1.6.2

This is a Factory hotfix. The Falco Worker runtime version remains 1.6.0.

## Safe Windows upgrade

1. Close Falco Studio.
2. Extract this release into a new folder.
3. Copy the complete `.generated` folder from your previous Factory folder into the new Factory folder. This preserves each local Worker project, knowledge files, snapshots, and `.falco-deployments.json` remote baselines.
4. Do not copy the old `node_modules` folder. Install the pinned dependencies in the new folder:

   ```powershell
   npm.cmd ci
   ```

5. Open `ABRIR_FALCO_STUDIO.cmd`.
6. Load the affected Worker under **Manage Existing**.
7. Confirm its remote baseline is `clean`.
8. Retry **Save & Deploy Changes**.

## What the hotfix does

Before a managed code deployment, Factory checks named imports from `src/providers/shared.mjs`.

If the project contains the exact known official v1.1 shared module and current runtime files require the missing exports `assertUsableOutput` or `providerFailurePayload`, Factory:

- saves the previous source in `.falco-history/<snapshot-id>.provider-runtime/`;
- replaces only `src/providers/shared.mjs` with the matching v1.6.0 runtime template;
- updates the existing runtime manifest, if present;
- continues with the explicitly requested deployment.

Customized or unrecognized `shared.mjs` files are never overwritten automatically. Factory stops before changing project files and asks for manual review.

No Cloudflare Worker is changed by installing or opening this release. The repair is applied locally only as part of an explicitly requested managed deployment, after remote preflight and a local snapshot.
