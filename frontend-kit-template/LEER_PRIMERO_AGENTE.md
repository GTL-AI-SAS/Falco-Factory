# ENTREGA OBLIGATORIA PARA EL AGENTE INTEGRADOR — FALCO

> **ESTE ARCHIVO ES PARTE DEL CONTRATO DE ENTREGA.** El chatbot no se considera integrado si la web funciona solo mediante un comando manual o si el agente entrega un `index.html` que el cliente debe abrir con doble clic usando `file://`.

## Debes entregar un `.cmd` funcional en la RAÍZ de la web FINAL

**Nombre obligatorio: `ABRIR_DEMO.cmd`** (no solamente dentro del ZIP de Falco).

Su comportamiento al hacer doble clic en Windows debe ser:

1. Ubicar automáticamente la raíz del proyecto con `cd /d "%~dp0"` (sin rutas absolutas del desarrollador).
2. Comprobar dependencias necesarias; mostrar errores claros si faltan.
3. Iniciar el servidor de desarrollo local de **la web final integrada**, no únicamente la demo de Falco, en `http://localhost:3000/`.
4. Abrir esa URL en el navegador predeterminado.
5. Mantener el servidor activo hasta que la persona cierre la consola o pulse Ctrl+C.
6. Funcionar desde una carpeta extraída del ZIP, incluso si la ruta tiene espacios.

### Si la web es HTML/CSS/JS estático

**NO hay que inventar el launcher:** copia los dos archivos que ya incluimos:

```text
DEL ZIP DE FALCO                           A LA RAÍZ DE LA WEB FINAL
integration/ABRIR_DEMO.cmd                  ABRIR_DEMO.cmd
integration/tools/falco-static-server.mjs   tools/falco-static-server.mjs
```

El `.cmd` inicia un servidor HTTP solo local, sin paquetes npm ni Python, con Node.js 20+.
El `index.html` **de la web final** debe estar junto a `ABRIR_DEMO.cmd`.

### Si la web usa React, Vite, Next.js u otro framework

Debes **crear/adaptar `ABRIR_DEMO.cmd` en la raíz del proyecto** para iniciar su servidor de desarrollo real en el puerto 3000 y abrir `http://localhost:3000/`.

- Por ejemplo, con Vite: ejecutar su `npm run dev -- --host localhost --port 3000 --strictPort` si ese script existe; resolver las dependencias de manera segura.
- Para Next.js u otro framework, utilizar sus comandos y flags reales. No copiar ciegamente el servidor estático, porque no compila ni ejecuta el framework.
- Si el framework no puede utilizar el puerto 3000, coordinar la adición del origen exacto (incluido el puerto) en Falco Factory **antes de dar la integración por terminada**.

## CORS y hosting: lo que NO puedes hacer

- **PROHIBIDO usar `file://`** para probar un widget que hace `fetch('/chat')` en Cloudflare; los navegadores suelen mandar `Origin: null` y el Worker responde 403.
- **PROHIBIDO habilitar `Origin: null`, `Access-Control-Allow-Origin: *`, desactivar seguridad del navegador o introducir una API key Gemini/OpenAI en el frontend.**
- Lee `ALLOWED_ORIGINS.json`: `http://localhost:3000` debe figurar si quieres que funcione durante el desarrollo. Si falta, solicita configurarlo en Falco Factory → Manage Existing → Allowed website origins → Save & Deploy Changes.
- En **GitHub Pages o Cloudflare Pages**, el hosting sirve la web por HTTPS sin necesitar `.cmd` en producción. Se debe autorizar el origen HTTPS real del sitio, **no** una ruta de repositorio ni el nombre de un proyecto.
- El `.cmd` es solo para ejecución local en Windows. No es requisito para que GitHub Pages o Cloudflare Pages funcionen.

## Acciones opcionales (Falco v1.1)

Lee `ACTIONS_MANIFEST.json` y `ACTION_INTEGRATION_GUIDE.md`. Si el manifest contiene `demo.open`, IMPLEMENTA y prueba la navegacion 01/02/03 con el controlador del kit, reusando la navegacion real de la web y dejando una sola instancia Falco en el parent page (no una por iframe). No uses eval, selectors inventados por IA, ni endpoints arbitrarios. Sin handlers locales, no hay acciones.

## Pruebas OBLIGATORIAS antes de entregar

- [ ] Entregué `ABRIR_DEMO.cmd` en la raíz de **la web terminada**.
- [ ] Probé doble clic en Windows o, si no dispongo de Windows, ejecuté y comprobé el servidor + revisé el `.cmd` e indiqué la limitación.
- [ ] `http://localhost:3000/` muestra la página final completa (no una demo aislada).
- [ ] Falco abre, envía una pregunta y muestra una respuesta real del Worker.
- [ ] Verifiqué en la pestaña Network/Red que `OPTIONS /chat` no falla por CORS y que `POST /chat` funciona.
- [ ] Confirmé que el `Origin` de desarrollo está listado en `ALLOWED_ORIGINS.json`, o señalé que el usuario debe actualizar el Worker.
- [ ] Probé los cambios de opción/pestaña si la web tiene demos o `iframe`, sin perder el chat cuando debe persistir.
- [ ] Documenté en el README final: «Para abrir la demo, doble clic en `ABRIR_DEMO.cmd`. Mantén la consola abierta».
- [ ] No inserté secretos en archivos públicos ni modifiqué CORS para permitir `null`.

**CRITERIO DE RECHAZO:** entregar solamente `index.html` + Falco y afirmar que está probado sin una URL `http://localhost:3000` o HTTPS autorizada no cumple el contrato.


## Falco v1.2 — Diagnóstico seguro de errores

`/chat` puede devolver `{ "error": "provider_model_not_found", "message": "...", "providerStatus": 404, "requestId": "UUID", "retryable": false }` con estado HTTP no 2xx. **Nunca renderices cuerpos de error crudos del proveedor ni claves de API.** El frontend puede mostrar el `requestId` y `providerStatus` para soporte técnico; usa `textContent` y evita insertar HTML no confiable. El código de error permite distinguir modelo inexistente, clave rechazada, límite gratuito, timeout, JSON inválido y bloqueo de seguridad. Cuando `retryable` es false no repitas automáticamente la petición; no malgastes cuota de Gemini. Las acciones solamente pueden ejecutarse cuando `/chat` devuelve una respuesta exitosa, válida y verificada por `action-controller.js`.
