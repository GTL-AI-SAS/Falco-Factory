# Falco backend contract — v0.6

`GET /health` returns `{ "status":"ok", "service":"falco", "business":"..." }` (no provider request).

`POST /chat` expects `Content-Type: application/json` and:

```json
{ "message": "Hola", "history": [{ "role": "user", "content": "Buenos días" }] }
```

Returns HTTP 200:

```json
{ "reply": "¡Hola!" }
```

Backend limits (current Factory Worker template): total request ≤ 16 KiB; current message ≤ 2,000 UTF-16 characters; history ≤ 8 entries with roles `user` or `assistant`, content ≤ 1,000 characters per entry; reply ≤ 4,000 characters. The client enforces those limits and keeps only successful turns. Its history is in memory, not in localStorage.

Errors: non-200 responses include `{ "error": "error_code" }` where examples include `origin_not_allowed` (403), `rate_limited` (429), `invalid_chat_payload` (400), and provider availability errors (502/503/504). Be ready for browser network/CORS errors without an HTTP response. The client exposes `FalcoError.code`, `.status` and a user-safe `.message`.

No authentication token or provider key is sent from the browser. Public endpoints still require Cloudflare rate limiting and abuse protection. A browser `Origin` check is NOT an API authentication mechanism.

See `core/falco-client.js` for the executable contract.
