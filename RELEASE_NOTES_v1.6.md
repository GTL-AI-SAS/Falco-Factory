# Falco Factory v1.6.0

Esta versión consolida la auditoría de v1.3 y el trabajo propuesto para v1.3.1–v1.6. Cada negocio conserva un Worker independiente. El API público sigue aceptando `POST /chat` y devuelve `{ reply, action? }`. Embedded es el modo predeterminado.

## Primer uso con un Worker existente

1. Extrae el ZIP en una carpeta nueva. Instala con `npm ci` o abre `ABRIR_FALCO_STUDIO.cmd`.
2. Autentícate en Wrangler con la cuenta correcta. `npm run falco:doctor -- --cloud` comprueba instalación y autenticación.
3. En Studio, carga el Worker. Si se importó desde una versión con historial previo, conserva su carpeta original.
4. Abre **Provider, remote versions and operations → Review remote state**. Compara el deployment ID, el reparto de tráfico, bindings y ajustes con la cuenta de Cloudflare. Para establecer una línea base nueva, confirma el nombre tras revisar el estado. Aceptar la línea base autoriza futuras escrituras contra ese estado y no importa cambios remotos al código local.
5. Usa **Upgrade runtime & deploy** para instalar las mejoras del runtime. El actualizador comprueba los archivos contra fuentes oficiales conocidas. Conserva una copia de los archivos originales.
6. Autoriza explícitamente una llamada de proveedor y ejecuta **Check live Worker**. Factory presenta salud, CORS y respuesta de chat por separado. El estado *ready* exige que pasen las tres comprobaciones. Los modos de mantenimiento y Turnstile pueden impedir el smoke de chat sin un token nuevo.

## Operación y recuperación

- **Restore knowledge** recupera FAQ, instrucciones y sus secciones locales. **Restore full configuration** tiene su propio diff y confirmación, e incluye orígenes, acciones y ajustes administrados. La identidad del Worker, la cuenta y el modo de almacenamiento se tratan por sus flujos respectivos. Cloudflare conserva las claves.
- **Regeneración.** `--force --dry-run` presenta el diff y `--force` respalda los archivos administrados antes de escribirlos. Las FAQ e instrucciones omitidas se conservan. Usa `--clear-faq` o `--clear-instructions` para vaciarlas. En Studio escribe el nombre del Worker y `CLEAR`.
- **Interrupciones.** Si el proceso de Factory murió durante una regeneración, confirma primero que ya no está activo. Quita el archivo hermano `<proyecto>.falco-lock` si quedó huérfano y ejecuta `node bin/falco.mjs recover "<ruta absoluta>" <id-del-backup>`. Si la interrupción ocurrió durante una operación remota, revisa primero la versión activa y el historial para evitar publicar dos veces.
- **Control remoto.** Factory compara el deployment ID, versiones, bindings, ajustes y subdominio antes de escribir. Guarda una línea base solo cuando identifica la nueva versión activa. Cloudflare no ofrece una precondición de compare-and-swap para el comando de Wrangler usado aquí. Coordina cambios simultáneos en el dashboard y en Factory.
- **Credenciales.** Los cambios de proveedor o de clave incluyen un preflight explícito. **Replace key** usa una versión nueva derivada del Worker activo y requiere que no haya una versión más reciente pendiente de publicación. Una clave de creación se carga con la versión. Para nuevos despliegues reales por CLI usa `FALCO_PROVIDER_API_KEY`; agrega `--check-provider` para autorizar un chat de verificación.
- **Staging.** Activa las Version URLs del Worker en Cloudflare y vuelve a revisar su línea base. **Stage version** sube y comprueba una versión con el tráfico de producción intacto. **Promote verified preview** despliega esa versión al 100 % tras verificar que la línea base sigue vigente. Una Version URL usa recursos de producción. Para probar con recursos aislados, usa un Worker de staging separado. Factory no inicia un reparto porcentual automáticamente.
- **Rollback.** Studio puede seleccionar una versión comprobada previamente. Cloudflare puede rechazar un rollback por incompatibilidad de claves, bindings o recursos. El contenido KV tiene su propio historial. Una revisión conserva un hash SHA-256 y el documento completo para mantener una lectura KV por chat y compatibilidad con v1.3. Factory verifica la publicación vía API y puede comprobar si una ubicación del edge ya ve el hash. La propagación global es eventual.
- **Presupuesto.** Activa el Durable Object por Worker desde ajustes. Reserva antes de llamar a Gemini/OpenAI y aplica límites globales de llamadas por día y mes UTC. Una respuesta de cuota abre el circuito. Turnstile es opcional y requiere un secreto `FALCO_TURNSTILE_SECRET` y un token de frontend por envío con acción `falco_chat`. Configura un secreto separado `FALCO_OPS_KEY` de al menos 32 caracteres para consultar métricas agregadas. Si lo cambias fuera de Factory, revisa la nueva línea base.
- **Consumo.** El panel muestra reservas, fallos, latencia, lecturas KV y tokens informados por el proveedor. Introduce tarifas unitarias para estimar coste. Una reserva puede no llegar al proveedor y los tokens de fallos pueden faltar. Las alertas de cuota/coste y los fallos se consultan en Studio. Los Logs de Workers son opt-in, muestreados y sin entradas del usuario.
- **Frontend.** En la configuración del kit puedes verificar el origen del sitio final, seleccionar un custom domain registrado en Cloudflare y añadir aviso de privacidad. El ZIP contiene un checklist de QA y un borrador de privacidad para completar por cliente. Puedes usar el Action Builder para editar enums y probar la ausencia de un handler sin llamar al proveedor.
- **Inventario y portabilidad.** Busca Workers por nombre o negocio, elige la cuenta, exporta un respaldo de los archivos administrados, clona un proyecto para crear otra identidad local y exporta el historial de operaciones saneado. Subir un clon es una operación aparte.

## Mapa de implementación

| ID | Resultado |
|---|---|
| F01–F03 | Dos flujos de restauración, regeneración con respaldo y recuperación, revisión de drift y línea base ligada a cuenta y Worker. |
| F04–F05 | Salud, CORS, chat real de una sola llamada y acción opcional. Ajuste de modelo, proveedor y rotación separada de clave. |
| F06–F07 | Presupuesto transaccional de llamadas, mantenimiento, Turnstile, circuito por cuota, Workers Logs muestreados y métricas agregadas. |
| F08–F10 | Staging con Version URLs, promoción explícita, rollback de versiones verificadas, respaldo exportable, timeout/cancelación de Wrangler y rollback KV independiente. |
| F11–F12 | Lockfile y Wrangler fijado, navegador y staging ejecutables, pipeline Linux/Windows y persistencia del historial por Worker. |
| F13–F18 | Advisor por tamaño del contexto, panel de consumo, editor de acciones, presets de restaurante/artista/atleta, clonación y test de compatibilidad. |
| F19–F23 | Dominio custom verificado, secciones de conocimiento, suite conversacional de staging, estados accesibles de acción y plantilla de privacidad. |
| F24–F26 | Indicadores de umbral consultables en Studio, inventario por cuenta y búsqueda, guía de integración con QA para agentes. |

## Verificación

`npm test` comprueba los flujos locales. `npm run test:worker-e2e` verifica el bundle en Workerd con KV, Durable Objects y CORS. `npm run test:browser` requiere Chromium instalado mediante `npx playwright install chromium`, o un ejecutable indicado por `FALCO_CHROMIUM`. El workflow de release incluye Node 22 y 24, Windows y Linux, y comprueba el lanzador desde el ZIP extraído.

Para staging, configura `FALCO_STAGING_URL` y `FALCO_STAGING_ORIGIN` en un Worker de pruebas habilitado para chat. Puedes agregar `FALCO_STAGING_KV_REVISION` para comprobar el hash en el edge. Ejecuta `npm run test:staging` para una llamada de proveedor. El modo `FALCO_STAGING_SUITE=1` requiere los cuatro patrones de expectativas del script y realiza cinco llamadas en total. Prueba rollback, cambio de claves y límites dependientes del proveedor contra recursos de staging antes de aplicar esos flujos en producción.

Referencias operativas: [Cloudflare Worker versions](https://developers.cloudflare.com/workers/versions-and-deployments/), [Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/), [KV](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [Durable Objects](https://developers.cloudflare.com/durable-objects/), [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
