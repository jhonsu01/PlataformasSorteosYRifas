# Backend — Sorteos y Rifas

API del framework (Node). Implementa reservas atómicas, webhook de Wompi con verificación
de firma, aprobación manual de comprobantes y un publicador *privacy-safe* hacia GitHub.
Persiste en **PostgreSQL** o, si no hay base configurada, en memoria (demo).

## Ejecutar

```bash
cd services/backend
npm install
npm start          # http://localhost:8787  (siembra la rifa "sorteo-demo")
npm test           # pruebas de memoria (+ PostgreSQL si hay DATABASE_URL)
```

## Persistencia

| `DATABASE_URL` | Almacenamiento | Sobrevive reinicios |
| --- | --- | --- |
| definida | **PostgreSQL** | ✅ Sí |
| vacía | memoria | ❌ No (solo demo) |

```bash
# Con PostgreSQL (las migraciones se aplican solas al arrancar)
DATABASE_URL=postgres://user:pass@host:5432/sorteos npm start
```

El esquema vive en [`infra/db/migrations/001_init.sql`](../../infra/db/migrations/001_init.sql)
y se aplica de forma **idempotente** al iniciar. La reserva de un número es atómica
(`UPDATE tickets ... WHERE status='FREE'` dentro de una transacción), por lo que dos
compradores simultáneos nunca obtienen el mismo número.

### Probar contra PostgreSQL real

Usamos el puerto **5433** para no chocar con un PostgreSQL ya instalado en la máquina
(que suele ocupar el 5432):

```bash
docker run --rm --name sorteos-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=sorteos_test -p 5433:5432 -d postgres:16
DATABASE_URL=postgres://postgres:postgres@localhost:5433/sorteos_test npm test
```

> ⚠️ Si el puerto ya está tomado por otro PostgreSQL, las conexiones se van a **ese**
> servidor (no al contenedor) y verás `28P01: password authentication failed`.
> Comprueba con `netstat -ano | findstr :5432`.
>
> Las pruebas ejecutan `TRUNCATE`, por lo que **abortan** si el nombre de la base no
> contiene `test`. Nunca apuntes `DATABASE_URL` a una base real al correr `npm test`.

El workflow de CI ejecuta estas pruebas contra un **PostgreSQL 16 real** en cada push
(incluye una prueba que verifica que los datos sobreviven a un reinicio y otra de
reservas concurrentes donde solo una gana).

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
