# Despliegue — Backend + Neon + Wompi

Objetivo: dejar el backend en una **URL pública HTTPS** para que Wompi pueda enviar el
webhook y se cierre el flujo de pago real.

> Los pasos que requieren **tus cuentas** (Neon, Vercel, Wompi) los haces tú: crear
> cuentas e iniciar sesión no es algo que el agente pueda hacer por ti. El código ya
> está preparado y verificado para desplegarse.

---

## 0. Prerrequisitos

| Servicio | Para qué | Plan |
| --- | --- | --- |
| [Neon](https://neon.tech) | PostgreSQL gestionado | Free |
| [Vercel](https://vercel.com) | Hosting serverless del backend | Hobby |
| [Wompi](https://comercios.wompi.co) | Pagos (Colombia) | Modo **test** primero |

---

## 1. Base de datos (PostgreSQL)

### Opción A — Desde Vercel (más simple)

Vercel → tu proyecto → **Storage → Create Database → Postgres (Neon)** → *Connect*.
Vercel inyecta automáticamente **`DATABASE_URL`** (ya con pooling y `sslmode=require`) en
el proyecto: es exactamente la variable que lee el backend, no hay que copiar nada a mano.

Luego aplica el esquema una vez (copia la cadena desde Storage → `.env.local`):

```bash
cd services/backend && npm install
DATABASE_URL="postgres://...-pooler.../db?sslmode=require" npm run migrate
```

> El backend también aplica la migración al arrancar (es idempotente), así que este paso
> es opcional; sirve para confirmar la conexión antes de desplegar.

### Opción B — Neon directamente

1. Crea un proyecto en Neon y una base, p. ej. `sorteos`.
2. Copia la **cadena de conexión con pooling** (la que contiene `-pooler`). Serverless abre
   muchas conexiones cortas; la pooled evita agotar el límite:
   ```
   postgres://user:pass@ep-xxx-pooler.region.aws.neon.tech/sorteos?sslmode=require
   ```
3. Aplica el esquema una vez:
   ```bash
   cd services/backend
   npm install
   DATABASE_URL="postgres://...-pooler.../sorteos?sslmode=require" npm run migrate
   # -> Migraciones aplicadas. Tablas: audit_log, draws, processed_events, purchases, raffles, tickets
   ```

El TLS se activa solo para hosts remotos (en `localhost` se desactiva).

---

## 2. Backend en Vercel

### Opción A — Proyecto ya conectado a GitHub (recomendado)

Si conectaste el repo desde el dashboard de Vercel, **el paso crítico es el Root Directory**:
este repo es un monorepo y la raíz **no tiene `package.json`**, así que sin esto el deploy
no construye nada.

1. Vercel → tu proyecto → **Settings → General**
   - **Root Directory** = `services/backend` → *Save*
   - **Framework Preset** = `Other`
2. **Settings → Environment Variables** → añade las de abajo (Production).
3. **Deployments** → *Redeploy* (o haz un push).

> **Cron y plan Hobby:** Vercel Hobby solo permite crons **una vez al día**; por eso
> `vercel.json` usa `0 4 * * *`. No es crítico: `reserve()` recupera las reservas vencidas
> de forma perezosa en la misma consulta SQL, así que un número expirado vuelve a estar
> disponible al instante aunque el cron no haya corrido.

### Opción B — Desde la CLI

```bash
npm i -g vercel
cd services/backend
vercel login          # abre el navegador (paso interactivo, lo haces tú)
vercel link           # crea/enlaza el proyecto
```

Configura las variables (o desde el dashboard → Settings → Environment Variables):

```bash
vercel env add DATABASE_URL production        # la cadena -pooler de Neon
vercel env add WOMPI_PUBLIC_KEY production    # pub_test_xxx
vercel env add WOMPI_PRIVATE_KEY production   # prv_test_xxx  (firma de integridad)
vercel env add WOMPI_EVENTS_KEY production    # evt_test_xxx  (verifica el webhook)
vercel env add WOMPI_ENV production           # test
vercel env add CRON_SECRET production         # cadena aleatoria (protege el cron)
vercel env add PG_POOL_MAX production         # 3
```

Despliega:

```bash
vercel --prod
# -> https://<tu-backend>.vercel.app
```

Comprueba:

```bash
curl https://<tu-backend>.vercel.app/health
# {"ok":true,"env":"test","storage":"postgres","wompiConfigured":true,...}
```

Si `storage` dice `memory`, falta `DATABASE_URL`. Si `wompiConfigured` es `false`, falta
`WOMPI_PUBLIC_KEY`.

### Qué se despliega

- `api/[...path].js` — catch-all: todo `/api/*` entra al enrutador de `src/app.js`.
- `vercel.json` — reescribe `/health`, incluye `migrations/**` en la función y registra el
  **cron** que libera reservas vencidas cada 10 min (`/api/cron/expire`, protegido con
  `CRON_SECRET`).

> No se usa `src/server.js` en Vercel: ese archivo es solo para `npm start` local.

---

## 3. Registrar el webhook en Wompi

En el panel de Wompi (modo test) → **Eventos / Webhooks**, registra:

```
https://<tu-backend>.vercel.app/api/webhooks/wompi
```

El backend **verifica la firma** del evento con `WOMPI_EVENTS_KEY` y rechaza los que no
coincidan (401). Es idempotente por `transaction.id`, así que los reintentos de Wompi no
duplican ventas.

---

## 4. Apuntar las apps

| App | Dónde | Valor |
| --- | --- | --- |
| APK cliente | icono **⚙** dentro de la app | `https://<tu-backend>.vercel.app` |
| Admin Windows | **Configuración** → URL del backend | `https://<tu-backend>.vercel.app` |

Con HTTPS ya no hace falta `usesCleartextTraffic` en Android (solo era para el backend
local por `http://`).

---

## 5. Probar el pago real (modo test)

1. En el APK, toca un número libre → completa el formulario → **Ir a pagar**.
2. Paga con una **tarjeta de prueba** de Wompi (las publica en su documentación de sandbox).
3. Al volver, la app consulta el estado hasta que el webhook confirme.
4. Verifica el efecto:
   ```bash
   curl https://<tu-backend>.vercel.app/api/raffles/sorteo-demo/public/numbers.json
   ```
   El número debe aparecer como vendido con el seudónimo (`"Juan S."`).

### Checklist si algo falla

| Síntoma | Causa probable |
| --- | --- |
| `401` en el webhook | `WOMPI_EVENTS_KEY` incorrecta o de otro entorno (test vs prod). |
| El número queda en `PENDING` | El webhook no llega: revisa la URL registrada y los logs (`vercel logs`). |
| `storage: memory` | Falta `DATABASE_URL` en el entorno de producción. |
| Error de conexión a Neon | Usa la cadena **-pooler** y `PG_POOL_MAX=3`. |
| Reservas que no se liberan | El cron requiere plan con Vercel Cron; si no, llama a `/api/cron/expire` desde un scheduler externo. |

---

## 6. Web pública (opcional)

`apps/web` es un proyecto Next.js aparte:

```bash
cd apps/web
vercel --prod
# Variable: NEXT_PUBLIC_GITHUB_RAW_BASE  (o apunta al backend)
```

---

## Seguridad antes de producción

- [ ] Cambiar Wompi a `prod` (`WOMPI_ENV=prod` + llaves `pub_prod_`/`prv_prod_`).
- [ ] Añadir **autenticación + 2FA** al admin y a los endpoints de escritura
      (hoy no hay auth: cualquiera con la URL puede aprobar comprobantes).
- [ ] `SEED_DEMO` debe quedar sin definir en producción (no siembra la rifa demo).
- [ ] Rate limiting en `/reserve` y en el webhook.
- [ ] Backups de Neon activados.
