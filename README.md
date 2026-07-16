<div align="center">

# 🎟️ Sorteos y Rifas

**Framework open source para crear y gestionar sorteos/rifas por números**, con app cliente Android (APK), app administrador Windows (MSI), web pública (Vercel) y GitHub como fuente de verdad pública.

[![Release](https://img.shields.io/github/v/release/jhonsu01/PlataformasSorteosYRifas?label=última%20release&color=7c3aed)](https://github.com/jhonsu01/PlataformasSorteosYRifas/releases/latest)
[![CI](https://github.com/jhonsu01/PlataformasSorteosYRifas/actions/workflows/ci.yml/badge.svg)](https://github.com/jhonsu01/PlataformasSorteosYRifas/actions/workflows/ci.yml)
[![Release build](https://github.com/jhonsu01/PlataformasSorteosYRifas/actions/workflows/release.yml/badge.svg)](https://github.com/jhonsu01/PlataformasSorteosYRifas/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

## 📦 Descargas

Los binarios se publican **automáticamente** en la [**última release**](https://github.com/jhonsu01/PlataformasSorteosYRifas/releases/latest):

| Artefacto | Archivo | Plataforma |
| --- | --- | --- |
| App cliente | `SorteosRifas-Cliente-<tag>.apk` | Android 7.0+ |
| App administrador | `SorteosRifas-Admin-<tag>.msi` | Windows 10/11 |

> Cada nueva versión reemplaza a la anterior: **siempre queda solo la última release**, con los binarios nombrados con su tag.

---

## 🧩 Estructura del monorepo

```
PlataformasSorteosYRifas/
├── apps/
│   ├── android/         # App cliente (Kotlin + Jetpack Compose → APK)
│   ├── admin-windows/   # App administrador (Tauri v2 → MSI)
│   └── web/             # Web pública (Next.js → Vercel)
├── packages/
│   └── schemas/         # JSON Schemas públicos (raffle / numbers / draw)
├── examples/
│   └── sorteo-demo/     # Datos públicos de ejemplo (raffle.json, numbers.json)
├── execution/           # Scripts: generador de iconos + validador de schema
├── infra/               # Configuración de infraestructura
├── docs/Guia.md         # Guía técnica completa
└── .github/workflows/   # CI + Release automático
```

---

## 💳 Flujo de compra (APK → Wompi → webhook)

```
Usuario toca un número libre en el APK
   └→ Backend reserva el número (atómico) y firma la referencia (HMAC integridad)
        └→ APK abre el Checkout de Wompi en un WebView
             └→ Wompi cobra y redirige (el APK detecta el retorno)
                  └→ Wompi envía el webhook al backend → firma verificada → número VENDIDO
                       └→ Se publica el estado público → web y apps lo reflejan
```

Configura la URL del backend desde el icono **⚙** de la app (no requiere recompilar).
Sin backend configurado, la app funciona en modo consulta sobre el JSON público.

Para que Wompi pueda enviar el webhook, el backend necesita una URL pública HTTPS:
sigue [`docs/DEPLOY.md`](docs/DEPLOY.md) (Vercel + Neon + Wompi, paso a paso).

## 🔒 Privacidad por diseño

El estado público (repo GitHub + web) **solo** contiene, por número vendido:
**nombre + inicial del apellido**, número, y marcas de tiempo de compra/verificación.

**Nunca** se publican documento, teléfono, correo, dirección ni la imagen del comprobante.
Un check de CI valida en cada cambio que el JSON público no contenga campos sensibles.

---

## 🚀 Releases automáticas (GitHub Actions)

El workflow [`release.yml`](.github/workflows/release.yml) se dispara al empujar un **tag** `vX.Y.Z`:

1. Compila el **APK** (Ubuntu + Gradle) y el **MSI** (Windows + Tauri) en paralelo.
2. Nombra los binarios con el tag.
3. **Borra las releases anteriores** (y sus tags) y publica **solo la última**.

```bash
# Publicar una nueva versión
git tag v1.1.0
git push origin v1.1.0     # → Actions construye y publica la release
```

El versionado se lleva en [`VERSION`](VERSION) y en los tags de git (fuente de verdad para el nombre de los binarios).

---

## 🛠️ Compilar localmente

| Artefacto | Requisitos | Comando |
| --- | --- | --- |
| APK | JDK 17, Android SDK 35 | `cd apps/android && gradle assembleRelease` |
| MSI | Rust, Node 20, WebView2 | `cd apps/admin-windows && npm install && npm run tauri build` |
| Web | Node 20 | `cd apps/web && npm install && npm run dev` |
| Backend | Node 20 (+ PostgreSQL opcional) | `cd services/backend && npm install && npm start` |

> El APK sin keystore se firma con la clave de debug (instalable). Para releases firmadas,
> el workflow usa los secretos `ANDROID_KEYSTORE_*` del repositorio.

### Iconos

Todos los iconos (escritorio + Android multi-densidad) se generan desde una sola ilustración:

```bash
python execution/gen_icons.py                                  # mipmaps Android (mdpi…xxxhdpi + adaptativos)
npx @tauri-apps/cli icon .tmp/icons/icon-source.png \
  -o apps/admin-windows/src-tauri/icons                        # set de escritorio (incluye .ico)
```

---

## 🚀 Guía de implementación paso a paso

Para alguien que **clona el repo** y quiere ponerlo en marcha, desde cero hasta cobrar
dinero real. Hay dos caminos: primero **probar en local** (sin crear ninguna cuenta), y
cuando todo funcione, **pasar a producción**.

> La versión detallada de despliegue está en [`docs/DEPLOY.md`](docs/DEPLOY.md). Esto es
> el mapa completo; ese documento profundiza en cada servicio.

### Requisitos

| Para… | Necesitas |
| --- | --- |
| Backend, web y tests | **Node 20+** |
| Correr todos los tests (con base real) | **Docker** (levanta un PostgreSQL de prueba) |
| Compilar el APK/MSI en tu equipo | JDK 17 + Android SDK 35 / Rust + WebView2 — **o** deja que lo haga GitHub Actions (recomendado) |

---

### Fase 0 · Clonar y probar en local (sin cuentas)

```bash
git clone https://github.com/jhonsu01/PlataformasSorteosYRifas
cd PlataformasSorteosYRifas
```

**Backend en modo memoria** (no necesita base de datos; se reinicia limpio y siembra una
rifa demo para probar):

```bash
cd services/backend
npm install
npm start
# -> http://localhost:8787  ·  [backend] almacenamiento: memory (sin persistencia)
```

Comprueba: `curl http://localhost:8787/health` → debe decir `"storage":"memory"`.

**Web en local** (lee el estado de GitHub; se le pasa el backend local para poder comprar):

```bash
cd apps/web
npm install
BACKEND_PUBLIC_BASE=http://localhost:8787 npm run dev
# -> http://localhost:3000
```

---

### Fase 1 · Correr los tests (hazlo antes de producción)

El backend trae **116 pruebas**. Sin base corren las de lógica en memoria; con PostgreSQL
corren **todas** (incluidas reserva atómica, privacidad y pagos):

```bash
cd services/backend
npm test                     # pruebas en memoria (rápidas)

# Suite completa contra PostgreSQL real (con Docker):
docker run --rm -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=sorteos_test -p 5432:5432 -d postgres:16
DATABASE_URL="postgres://postgres:postgres@localhost:5432/sorteos_test" \
  JWT_ACCESS_SECRET="clave-cualquiera-para-test" npm test
# -> # tests 116 · # pass 116 · # fail 0
```

Y la validación de **privacidad** del estado público (lo mismo que corre CI en cada push):

```bash
python execution/validate-schema.py examples/sorteo-demo/public/numbers.json numbers
# -> [OK] ... no expone datos sensibles.
```

> Los tests se ejecutan **en serie** (`--test-concurrency=1`): varios tocan el mismo
> PostgreSQL y en paralelo darían fallos intermitentes por contención de conexiones.

---

### Fase 2 · Base de datos (Neon)

Crea un PostgreSQL gestionado en [Neon](https://neon.tech) (plan Free) y copia la cadena
**con pooling** (la que contiene `-pooler`). Aplica el esquema una vez:

```bash
cd services/backend
DATABASE_URL="postgres://...-pooler.../db?sslmode=require" npm run migrate
# -> Migraciones aplicadas. Tablas: audit_log, draws, processed_events, purchases, raffles, tickets
```

*(El backend también migra solo al arrancar; este paso solo confirma la conexión.)*

---

### Fase 3 · Backend en Vercel

Conecta el repo en [Vercel](https://vercel.com) y, en **Settings → General**, pon
**Root Directory = `services/backend`** y **Framework Preset = Other** (es un monorepo: sin
esto no compila nada). Luego añade las variables en **Settings → Environment Variables
(Production)**:

| Variable | Obligatoria | Valor |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | la cadena **-pooler** de Neon |
| `JWT_ACCESS_SECRET` | ✅ | genera con `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `WOMPI_ENV` | ✅ | `test` (luego `prod`) |
| `WOMPI_PUBLIC_KEY` | ✅ | `pub_test_…` |
| `WOMPI_INTEGRITY_SECRET` | ✅ | `test_integrity_…` (firma el checkout) |
| `WOMPI_EVENTS_KEY` | ✅ | `test_events_…` (valida el webhook) |
| `CRON_SECRET` | ✅ | cadena aleatoria (protege el cron de expiración) |
| `PG_POOL_MAX` | — | `3` |
| `GITHUB_RIFFLES_TOKEN` | opcional | PAT fine-grained (ver Fase 5) |
| `GITHUB_RIFFLES_OWNER` | opcional | tu organización de GitHub |
| `WEB_PUBLIC_BASE` | opcional | URL de tu web pública (para el enlace del repo) |

> ⚠️ **Sin `JWT_ACCESS_SECRET` el backend no arranca** (responde 500) si hay `DATABASE_URL`.
> Es a propósito: en serverless cada contenedor generaría un secreto distinto y las
> sesiones se caerían al azar.
>
> ⚠️ **Las 4 llaves de Wompi no son intercambiables** y `WOMPI_ENV` es solo `test`/`prod`
> (nunca pegues un secreto ahí: `/health` lo publicaría). El detalle, en `docs/DEPLOY.md`.

Redespliega y comprueba: `curl https://<tu-backend>.vercel.app/health` → `storage: postgres`,
`wompiConfigured: true`.

---

### Fase 4 · Crear la cuenta de administrador + 2FA

El administrador **no se crea desde la app**: se crea con un script contra la base (así la
clave nunca queda en el historial del navegador). Necesita `DATABASE_URL` (no funciona en
modo memoria):

```bash
cd services/backend
DATABASE_URL="postgres://...-pooler.../db?sslmode=require" \
ADMIN_EMAIL="tu@correo.com" ADMIN_PASSWORD='una-clave-larga-y-unica' \
  npm run create-admin
# -> Administrador creado: tu@correo.com (SUPER_ADMIN)
```

*(Rol por defecto `SUPER_ADMIN`; opcional `ADMIN_ROLE=ADMIN|OPERATOR`. Mínimo 12 caracteres.)*

Luego, en la **app Admin** (descárgala de la [última release](https://github.com/jhonsu01/PlataformasSorteosYRifas/releases/latest)):

1. **Configuración** → URL del backend = `https://<tu-backend>.vercel.app` → Guardar.
2. Inicia sesión con el correo y la clave.
3. **Seguridad** → *Generar secreto* → añádelo en Google Authenticator/Authy → escribe el
   código → **Activar 2FA**. Es obligatorio para `SUPER_ADMIN`/`ADMIN`: sin 2FA, una clave
   filtrada bastaría para aprobar pagos.

---

### Fase 5 · GitHub como fuente pública (opcional, recomendado)

Cada rifa vive en su repo público y cada venta es un commit: el sorteo queda auditable sin
depender del backend. Crea una **organización dedicada** y un **PAT fine-grained** (Resource
owner = la org; Contents: Read/Write; Administration: Read/Write para crear los repos), y
ponlos en Vercel como `GITHUB_RIFFLES_TOKEN` y `GITHUB_RIFFLES_OWNER`. Paso a paso completo
en [`docs/DEPLOY.md`](docs/DEPLOY.md#27-github-como-fuente-de-verdad-pública-guía-8).

> ⚠️ **No la llames `GITHUB_TOKEN`**: en Vercel ese nombre no llega a la función. Usa
> `GITHUB_RIFFLES_TOKEN`.

---

### Fase 6 · Web pública (opcional)

`apps/web` es un proyecto Next.js aparte (segundo proyecto de Vercel, **Root Directory =
`apps/web`**). Variables:

| Variable | Valor |
| --- | --- |
| `RIFFLES_OWNER` | tu organización de GitHub (de dónde lee las rifas) |
| `BACKEND_PUBLIC_BASE` | `https://<tu-backend>.vercel.app` (para comprar desde la web) |
| `RIFFLES_BRANCH` | `main` (opcional) |

---

### Fase 7 · Probar el pago en modo TEST

1. En el panel de Wompi (test) → **Eventos/Webhooks**, registra
   `https://<tu-backend>.vercel.app/api/webhooks/wompi`.
2. En la app o en la web, compra un número → paga con una **tarjeta de prueba** de Wompi.
3. El número debe quedar vendido:
   `curl https://<tu-backend>.vercel.app/api/raffles/<slug>/public/numbers.json`

---

### Fase 8 · Pasar a dinero real (test → producción)

Cuando todo funcione en test, el cambio a producción es **reemplazar en Vercel** las llaves
de Wompi por las de producción y redesplegar:

- [ ] `WOMPI_ENV` = **`prod`**
- [ ] `WOMPI_PUBLIC_KEY` = `pub_prod_…`
- [ ] `WOMPI_INTEGRITY_SECRET` = `prod_integrity_…`
- [ ] `WOMPI_EVENTS_KEY` = `prod_events_…`
- [ ] Registrar el webhook en el panel de Wompi **de producción**.
- [ ] Si algún secreto de *test* estuvo expuesto (p. ej. pegado por error en `/health`),
      **rótalo** en Wompi.
- [ ] `SEED_DEMO` sin definir (no sembrar la rifa demo en producción).
- [ ] 2FA activo en la cuenta de administrador.
- [ ] Backups de Neon activados.

> Tras cambiarlas, `curl .../health` debe mostrar `"env":"prod"`.

La guía técnica de arquitectura está en [`docs/Guia.md`](docs/Guia.md); el despliegue
detallado, en [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## ⚖️ Descargo de responsabilidad

**Sorteos y Rifas es software libre, entregado «tal cual», sin garantías de ningún tipo.**

En la mayoría de los países las **rifas y sorteos están regulados por la ley**. La persona u
organización que crea y opera cada sorteo es la **única responsable** de:

- cumplir la normativa y obtener los **permisos** aplicables en su jurisdicción;
- **recaudar y administrar los pagos**;
- **entregar el premio** al ganador.

El autor del software **no organiza sorteos**, no interviene en los pagos ni en la entrega de
premios, y **no se hace responsable** del uso que terceros den a esta herramienta ni de la
legalidad de los sorteos creados con ella. Al usar este software aceptas ser el **único
responsable** de tus sorteos.

> Este texto es informativo y **no constituye asesoría legal**. Consulta la normativa de tu
> jurisdicción antes de operar un sorteo.

---

## 📄 Licencia

[MIT](LICENSE) — úsalo, modifícalo y distribúyelo libremente.

---

## 💜 Apoya el proyecto

Este proyecto es **gratuito y de código abierto**. Si te resulta útil, puedes apoyar su
desarrollo con una donación en Ko-fi:

<div align="center">

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/V7V81LV7GX)

</div>
