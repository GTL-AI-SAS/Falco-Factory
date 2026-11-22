# GTL AI — Falco Factory Knowledge Architecture (ADR-001)

**Fecha:** 2026-11-21 · **Baseline:** Falco Factory v1.0 · **Estado:** Decisión adoptada

## Decisión

**Mantener v1.0 para restaurantes y negocios pequeños** mientras el conocimiento permanezca dentro de las cotas de la etapa A. No necesitamos v1.1 hoy. La próxima versión de almacenamiento externo solo se justifica si hay cambios frecuentes, volumen significativo o un presupuesto de contexto excesivo. No incluir instrucciones privadas en el frontend.

## Reglas de decisión (GTL AI, no límites oficiales)

Evaluar por Worker, sobre una ventana móvil de 30 días; aplicar precedencia D > C > B > A. Medir tokens reales cuando sea posible.

| Etapa | Disparadores medibles | Acción |
|---|---|---|
| A — Embedded | TODOS: KB <= 4.000 tokens y <= 32 KiB UTF-8; instrucciones <= 1.500 tokens; <= 10 docs; <= 4 publicaciones/mes; prompt de entrada p95 <= 6.000 tokens | Mantener Worker embebido y Factory v1.0 |
| B — KV | CUALQUIERA: >4 publicaciones/mes, KB >32 KiB, KB >4.000 tokens, >10 documentos o edición sin redeploy obligatoria | KV para conocimiento; mantener instrucciones aparte. Si prompt p95 >6k, activar C también |
| C — KV + selección | CUALQUIERA: p95 de prompt entrada >6.000 tokens, corpus KB >12.000 tokens, >25 documentos o más del 50% del contexto es irrelevante | Seleccionar 2–5 secciones; contexto recuperado <=3.500 tokens por pregunta |
| D — Evaluar RAG / SQL | CUALQUIERA: corpus >50.000 tokens, >100 docs, o recall@5 <90% tras dos iteraciones sobre >=40 preguntas reales | Comparar recuperación tradicional vs vector; SQL/D1 si catálogo estructurado; decidir por calidad y costo |

Estas son cotas internas deliberadamente conservadoras, NO topes impuestos por Cloudflare/Gemini. Se revisan con métricas reales.

## Excepciones

- Inventario, disponibilidad, reservas o información que requiere consistencia inmediata: SQL/API operativa, no KV eventual.
- Datos sensibles o confidenciales: políticas y segregación específica; no publicar en frontend.
- Errores 429 Gemini: revisar cuotas del proveedor; no se solucionan cambiando almacenamiento.

## Límites oficiales consultados (2026-11-21)

- Workers Free: 100.000 solicitudes/día, 100 Workers por cuenta, 64 MiB de bundle, 10ms CPU por solicitud. Variables individuales: 5KB.
- Workers KV Free: 1 GB almacenamiento/cuenta; 100.000 lecturas/día; 1.000 escrituras/día; cada valor hasta 25 MiB. Cuotas compartidas.
- KV eventual: propagación global de hasta 60 segundos o más.
- Las cuotas y facturación de la API de Gemini son independientes de Cloudflare.

Ejemplo: 20 clientes x 150 chats/día x 2 lecturas KV/chat = 6.000 lecturas KV/día (sin otras cargas).

## Instrumentación mínima

Medir `knowledge_bytes_utf8`, `knowledge_tokens`, `instructions_tokens`, `documents_count`, `knowledge_updates_30d`, prompt tokens p50/p95, latencia, 429, y lecturas KV. Al evaluar etapa D: mínimo 40 preguntas anotadas con recall@5 y calidad de respuesta fundamentada. No registrar secretos ni texto sensible.

## Roadmap sin sobreingeniería

1. **Hoy, v1.0:** no cambiar.
2. **v1.0.x opcional:** contadores, alertas por cota y export de métricas.
3. **v1.1 al dispararse B:** editor multi-documento, KV, publicación independiente, versiones y rollback.
4. **Evolución de recuperación al dispararse C:** selección por categoría / palabra clave.
5. **Solo al dispararse D:** PoC RAG versus recuperación determinista o D1/SQL.

## Fuentes oficiales

- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Worker size increase (Sep 2026): https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/
- Cloudflare Workers KV limits: https://developers.cloudflare.com/kv/platform/limits/
- Cloudflare Workers KV pricing: https://developers.cloudflare.com/kv/platform/pricing/
- KV consistency: https://developers.cloudflare.com/kv/concepts/how-kv-works/
- Vectorize pricing: https://developers.cloudflare.com/vectorize/platform/pricing/
- Gemini API pricing and free tier: https://ai.google.dev/gemini-api/docs/pricing

*Revisar cotas de proveedor trimestralmente.*
