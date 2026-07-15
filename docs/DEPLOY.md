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
vercel env add JWT_ACCESS_SECRET production      # OBLIGATORIO (ver aviso abajo)
vercel env add DATABASE_URL production           # la cadena -pooler de Neon
vercel env add WOMPI_ENV production              # exactamente: test
vercel env add WOMPI_PUBLIC_KEY production       # pub_test_...
vercel env add WOMPI_INTEGRITY_SECRET production # test_integrity_...
vercel env add WOMPI_EVENTS_KEY production       # test_events_...
vercel env add CRON_SECRET production            # cadena aleatoria (protege el cron)
vercel env add PG_POOL_MAX production            # 3
```

### ⚠️ Las 4 llaves de Wompi no son intercambiables

| Wompi te muestra | Va en | Para qué |
| --- | --- | --- |
| Llave pública `pub_test_…` | `WOMPI_PUBLIC_KEY` | abrir el checkout (es pública) |
| Secreto de integridad `test_integrity_…` | `WOMPI_INTEGRITY_SECRET` | firmar el monto/referencia |
| Secreto de eventos `test_events_…` | `WOMPI_EVENTS_KEY` | validar la firma del webhook |
| Llave privada `prv_test_…` | *(no se usa)* | API REST de Wompi |

`WOMPI_ENV` es **solo** `test` o `prod`. **Nunca pegues un secreto ahí**: además de romper la
configuración, quedaría visible en `/health` y en la app Admin. Si te pasa, **rota ese secreto
en Wompi**.

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

## 2.5. Autenticación (haz esto antes que Wompi)

### `JWT_ACCESS_SECRET` es obligatorio

Con `DATABASE_URL` presente, **el backend se niega a arrancar sin él** y responde `500`.
Es a propósito: en serverless cada contenedor generaría un secreto distinto y las
sesiones se caerían al azar, sin error visible. Mejor fallar fuerte.

Genera uno y añádelo en **Settings → Environment Variables → Production**:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Luego **Redeploy**.

### Crear el primer administrador

```bash
cd services/backend
DATABASE_URL="postgres://...-pooler.../db?sslmode=require" \
ADMIN_EMAIL="tu@correo.com" ADMIN_PASSWORD='una-clave-larga-y-unica' \
  npm run create-admin
# -> Administrador creado: tu@correo.com (SUPER_ADMIN)
```

> Las credenciales van por variables de entorno para no quedar en el historial del shell.
> Mínimo 12 caracteres. Rol por defecto `SUPER_ADMIN` (o `ADMIN_ROLE=ADMIN|OPERATOR`).

### Activar 2FA

Abre la app Admin → inicia sesión → **Seguridad** → *Generar secreto* → añádelo en Google
Authenticator/Authy (entrada manual) → escribe el código → **Activar 2FA**.

La Guía lo exige para `SUPER_ADMIN`/`ADMIN`: sin 2FA, una contraseña filtrada basta para
aprobar pagos o declarar ganadores.

### Qué queda protegido

| Endpoint | Acceso |
| --- | --- |
| `POST /api/raffles` · `POST /api/purchases/:id/approve` · `/reject` · `POST /api/raffles/:slug/draw` | **ADMIN+** |
| `GET /api/raffles/:slug/purchases` (contiene teléfono/correo) | **OPERATOR+** |
| `GET /health` · JSON público · `POST /api/raffles/:slug/reserve` · webhook de Wompi | público |

El webhook no lleva JWT: se autentica con la **firma de Wompi** (`WOMPI_EVENTS_KEY`).

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
