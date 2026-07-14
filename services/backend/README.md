# Backend — Sorteos y Rifas

API del framework (Node, **sin dependencias**: `http` + `crypto` nativos). Implementa
reservas atómicas, webhook de Wompi con verificación de firma, aprobación manual de
comprobantes y un publicador *privacy-safe* hacia GitHub. Store en memoria (reemplazable
por PostgreSQL en producción).

> Estado: **MVP funcional**. Ejecutable y probado (`npm test`). El store en memoria y el
> push a GitHub son adaptables a DB real + GitHub App en las siguientes fases.

## Ejecutar

```bash
cd services/backend
npm start          # http://localhost:8787  (siembra la rifa "sorteo-demo")
npm test           # 6 pruebas: privacidad, reserva atómica, ganador, firma Wompi
```

## Endpoints

| Método | Ruta | Descripción |
| --- | --- | --- |
| `GET`  | `/health` | Estado del servicio. |
| `POST` | `/api/raffles/:slug/reserve` | Reserva atómica de un número. Devuelve config del Widget Wompi (reference + firma de integridad). |
| `POST` | `/api/purchases/:id/receipt` | Adjunta comprobante manual (privado). |
| `POST` | `/api/purchases/:id/approve` | Aprueba → número `SOLD`, `verifiedAt`, publica estado público. |
| `POST` | `/api/purchases/:id/reject` | Rechaza → libera el número. |
| `POST` | `/api/webhooks/wompi` | Evento Wompi: verifica firma, idempotencia, `APPROVED→SOLD`. |
| `POST` | `/api/raffles/:slug/draw` | Declara ganador (valida que el número esté `SOLD`). |
| `GET`  | `/api/raffles/:slug/public/raffle.json` | Estado público de la rifa. |
| `GET`  | `/api/raffles/:slug/public/numbers.json` | Números vendidos (seudonimizados). |
| `GET`  | `/api/checkout/signature` | Firma de integridad para el checkout. |

## Ejemplo (reserva → aprobación → estado público)

```bash
curl -X POST localhost:8787/api/raffles/sorteo-demo/reserve \
  -H 'Content-Type: application/json' \
  -d '{"number":5,"buyer":{"firstName":"Ana","lastName":"Gomez","phone":"3001234567"}}'
# -> { purchaseId, reference, integritySignature, ... }

curl -X POST localhost:8787/api/purchases/<id>/approve -d '{"approvedBy":"admin"}'
curl localhost:8787/api/raffles/sorteo-demo/public/numbers.json
# -> { "sold":[{ "number":5, "buyer":"Ana G.", "purchasedAt":..., "verifiedAt":... }] }
```

## Privacidad por diseño

El estado público **solo** contiene `number`, `buyer` (`Nombre I.`), `purchasedAt` y
`verifiedAt`. Teléfono, correo, documento, apellido completo y comprobante viven en el
objeto `private` de cada compra y **jamás** se serializan a la salida pública
(verificado por prueba automática).

## Webhook de Wompi

`verifyEventSignature` calcula `SHA256(concat(valores de signature.properties) + timestamp
+ WOMPI_EVENTS_KEY)` y lo compara (timing-safe) con `signature.checksum`. Idempotencia por
`transaction.id`. Mapeo: `APPROVED → SOLD`, `DECLINED/ERROR/VOIDED → liberar`, `PENDING → esperar`.

> El esquema de checksum sigue la documentación de Wompi; **valídalo contra un evento real**
> (modo test) antes de pasar a producción.

## Variables de entorno

Ver [`.env.example`](../../.env.example): `WOMPI_PUBLIC_KEY`, `WOMPI_PRIVATE_KEY`
(integridad), `WOMPI_EVENTS_KEY` (webhook), `GITHUB_TOKEN` + `GITHUB_RIFFLES_ORG`
(publicación). Sin `GITHUB_*`, el publicador corre en modo demo (no escribe a GitHub).
