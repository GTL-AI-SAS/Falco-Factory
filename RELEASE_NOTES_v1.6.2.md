# Falco Factory v1.6.2 — Provider Runtime Compatibility Hotfix

## Problem fixed

Some older Workers upgraded through the Client Actions compatibility path could contain a mixed runtime:
- `src/index.mjs` and `src/client-actions.mjs` were replaced with current modules.
- `src/providers/shared.mjs` remained at the v1.1 revision.
- The current modules import `providerFailurePayload` and `assertUsableOutput`, which the old shared module does not export.
- Wrangler then failed at build time with missing-export errors.

The old regression test did not reproduce this because it created a current Worker and replaced only `index.mjs`, leaving a current `shared.mjs` in place.

## Changes

- Added provider-runtime compatibility inspection before managed code deployments.
- Detects named imports from `src/providers/shared.mjs` and compares them with actual exports.
- Automatically repairs only the exact known official v1.1 `shared.mjs` fingerprint.
- Refuses to overwrite customized or unknown `shared.mjs` source.
- Creates a local backup under `.falco-history/<snapshot>.provider-runtime/`.
- Updates an existing `.falco-runtime.json` fingerprint after repair.
- Handles both:
  - an existing partially upgraded Worker where only knowledge is being changed;
  - a legacy Client Actions upgrade where the new index/action modules are planned but not yet written.
- Adds regression coverage for both paths and for fail-closed behavior on customized source.

## Compatibility and safety

- Factory version: **1.6.2**
- Worker runtime version: remains **1.6.0**
- Wrangler: remains **4.166.0**
- No Cloudflare Worker is changed until the user explicitly runs the managed deployment operation.
- The compatibility repair happens only after the remote preflight and local snapshot.
- Unknown/custom provider modules are not overwritten automatically.

## Validation

- `npm test`: **118/118 passed**.
- Includes a regression test reproducing the exact missing-export mismatch.
- No real Cloudflare deployment was performed in this build environment.
