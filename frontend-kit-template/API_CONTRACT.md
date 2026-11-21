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


## Client Actions v1.1 (optional, backwards-compatible)

With actions enabled, a successful response MAY include: `{"reply":"Te muestro la opcion 02.","action":{"id":"demo.open","params":{"option":"02"}}`. The Worker validates the action against its declared manifest. The browser MUST validate it again and call only a registered local handler. `reply` never proves execution; `action` is a proposal, not an instruction to run arbitrary code. Legacy clients can ignore it.


## Falco v1.2 — Diagnóstico seguro de errores

`/chat` puede devolver `{ "error": "provider_model_not_found", "message": "...", "providerStatus": 404, "requestId": "UUID", "retryable": false }` con estado HTTP no 2xx. **Nunca renderices cuerpos de error crudos del proveedor ni claves de API.** El frontend puede mostrar el `requestId` y `providerStatus` para soporte técnico; usa `textContent` y evita insertar HTML no confiable. El código de error permite distinguir modelo inexistente, clave rechazada, límite gratuito, timeout, JSON inválido y bloqueo de seguridad. Cuando `retryable` es false no repitas automáticamente la petición; no malgastes cuota de Gemini. Las acciones solamente pueden ejecutarse cuando `/chat` devuelve una respuesta exitosa, válida y verificada por `action-controller.js`.
