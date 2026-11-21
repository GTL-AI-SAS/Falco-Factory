# Falco Factory v1.2 — Safe Diagnostics (2026-11-21)

**New:** granular provider HTTP classification; safe correlation `requestId`; redacted structured logs; Retry-After passthrough for bounded numeric provider hints; handling for truncated and blocked completions; improved frontend kit and local Studio error messages.

**New operation:** Manage Existing → **Upgrade runtime & deploy**. Exact-hash allowlist of official v1.1 runtime files prevents overwriting customized Worker modules. Saves original file sources under `.falco-history/<snapshot-id>.runtime-source/` before deploying, preserves existing Cloudflare API secrets, provider settings, CORS origin allowlist and Worker name.

**No guarantee that a Gemini upstream error is resolved by this version:** the providerStatus and requestId make the underlying HTTP response diagnosable without leaking secrets. For example, `providerStatus: 400` points to request format/model settings; `404` indicates model availability, `429` quota. No automatic retries or changes to AI model ID were introduced.

**Compatibility:** `/health` adds the non-secret `runtimeVersion: "1.2.0"` field to verify deployment; successful `/chat` and optional `action` formats unchanged. Older frontends work; new frontend kit and Gallinas example display safer, more actionable errors.

**Caveats:** in-place upgrade applies only to the official v1.1 source fingerprints; never forcibly replaces a customized runtime. The backup stores original source in the old local project (not in Cloudflare), and knowledge history Restore is not a runtime rollback. Use Wrangler/Cloudflare deploy rollback or carefully restore the backed-up source if necessary. A successful code deploy does not itself confirm provider connectivity; click Test /chat.

**Testing:** Node automated suite, local Worker error simulations, provider failure mapping and Studio upgrade integration. No real Cloudflare deployment or Gemini invocation claimed.
