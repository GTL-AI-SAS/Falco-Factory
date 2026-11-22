# Falco Factory v1.6.3 — Deployment Verification Upgrade

## Summary

Makes deployment verification explicit, cost-aware, and useful for both chat and Client Actions.

## Verification states

- `pass`: check ran and succeeded.
- `failed`: check ran and failed.
- `skipped`: an earlier prerequisite failed, so the check could not run.
- `not_configured`: no applicable feature exists (for example, no Client Actions are configured).
- `not_authorized`: the check could run, but the user did not authorize a live provider request.
- `unsupported_provider`: Client Actions are configured, but Mock cannot generate action proposals.

## Behavior

- Health and configured-origin CORS checks remain automatic.
- Paid `/chat` checks remain opt-in.
- Optional Client Action proposal checks are opt-in and require Gemini or OpenAI, at least one configured Client Action, and a 3–500 character test message.
- The first configured action is tested using its first allowed enum value for each parameter.
- A Client Action test uses exactly one `/chat` request and therefore also verifies the chat response. Selecting both chat and action verification does not make two provider calls.
- The smoke test only inspects the action proposal returned by Falco. It never executes a website handler or performs navigation.
- The same options are available during Create & Deploy, Manage Existing → Save & Deploy, and Check live Worker.
- Verification states are displayed in the release log and operation history.

## Cost and safety

- No live AI request is made unless the user explicitly selects a chat or action verification option.
- Mock health/chat checks remain free. Mock does not support Client Action proposal generation; Studio reports `unsupported_provider`.
- A wrong action proposal is reported separately from a successful chat reply.
- Provider response bodies, secrets, and test prompt contents are not copied into operation logs.

## Validation

- Node automated test suite: 127 tests.
- Regression coverage includes no-request authorization states, action proposal pass/fail, Mock unsupported state, one-request combined chat/action checks, and Studio deployment orchestration.
- No live Cloudflare deployment or paid provider request was performed during local validation.
