# Guía Técnica — Framework Open Source de Gestión de Sorteos y Rifas

> **Proyecto:** PlataformasSorteosYRifas
> **Versión de la guía:** 1.0.0
> **Fecha:** 2026-07-14
> **Licencia sugerida:** MIT (open source)
> **Idioma base:** Español (Colombia)

---

## 0. Tabla de contenidos

1. [Resumen ejecutivo y principios](#1-resumen-ejecutivo-y-principios)
2. [Arquitectura general](#2-arquitectura-general)
3. [Stack tecnológico](#3-stack-tecnológico)
4. [Modelo de datos](#4-modelo-de-datos)
5. [Roles y accesos seguros](#5-roles-y-accesos-seguros)
6. [Flujo de pago y aprobación (Wompi + comprobante manual)](#6-flujo-de-pago-y-aprobación)
7. [Privacidad por diseño: datos públicos vs. privados](#7-privacidad-por-diseño)
8. [Sincronización con GitHub y publicación en Vercel](#8-sincronización-con-github-y-publicación-en-vercel)
9. [Declaración del ganador y postergación](#9-declaración-del-ganador-y-postergación)
10. [Estructura del repositorio (monorepo)](#10-estructura-del-repositorio-monorepo)
11. [Guía de implementación paso a paso (replicable)](#11-guía-de-implementación-paso-a-paso-replicable)
12. [Checklist de seguridad y cumplimiento](#12-checklist-de-seguridad-y-cumplimiento)
13. [Variables de entorno (referencia)](#13-variables-de-entorno-referencia)
14. [Roadmap y extensiones](#14-roadmap-y-extensiones)
15. [Glosario](#15-glosario)

---

## 1. Resumen ejecutivo y principios

### 1.1 Qué es

Un **framework open source** que permite a cualquier organizador crear y gestionar **sorteos/rifas por números**, con:

- Una **app cliente Android** (APK) donde el público compra números.
- Una **app de administración para Windows** (instalador MSI) donde el administrador configura el sorteo, aprueba pagos y declara el ganador.
- Un **sitio web público** desplegado en **Vercel** que muestra los datos del sorteo y los números vendidos.
- Un **repositorio GitHub** como fuente de verdad pública del estado de cada sorteo.

La inspiración funcional es **servicellarauca.app** (venta de números por catálogo, comprobantes de pago y aprobación manual), mejorada con **pasarela de pagos Wompi** (Widget Checkout Web) y un flujo estricto de **privacidad por diseño**.

### 1.2 Principios rectores

| Principio | Qué significa en la práctica |
| --- | --- |
| **Open source replicable** | Cualquier persona puede clonar el repo, configurar sus credenciales y lanzar su propio sorteo sin tocar el código. |
| **Privacidad por diseño** | Los datos personales (documento, teléfono, correo, dirección, imagen del comprobante) **nunca** se publican. Solo se publica el nombre + inicial del apellido, el número comprado y las marcas de tiempo. |
| **GitHub como fuente de verdad pública** | El estado público del sorteo (configuración, números vendidos, ganador) se versiona en Git. Cada confirmación del administrador actualiza la web y las apps. |
| **Separación planos/secretos** | Las claves privadas de Wompi, tokens de GitHub y secretos del backend viven en variables de entorno; nunca en el repo ni en la app cliente. |
| **Pago-aprobado = número vendido** | Un número solo se marca como **vendido** cuando un pago es aprobado (por webhook de Wompi o aprobación manual del admin). |
| **Auditable** | Cada acción relevante (venta, aprobación, rechazo, declaración de ganador) queda registrada en un log inmutable con marca de tiempo. |

---

## 2. Arquitectura general

### 2.1 Componentes

```
┌────────────────────────────────────────────────────────────────────────┐
│                         ADMINISTRADOR (humano)                          │
│                                                                         │
│   App Admin Windows (MSI)  ◄── Tauri/Electron + React                   │
│   - Configura rifa (datos, imágenes, rango de números)                  │
│   - Aprueba/rechaza pagos manuales                                      │
│   - Declara ganador                                                     │
│   - Inicia/pospone/cierra sorteo                                        │
└───────────────┬─────────────────────────────────────────┬──────────────┘
                │ (HTTPS + JWT, 2FA)                       │ git push (vía
                │                                          │ API GitHub)
                ▼                                          ▼
┌──────────────────────────────────┐        ┌─────────────────────────────┐
│   BACKEND (API en Vercel)        │        │  REPOSITORIO GITHUB          │
│   - Next.js API Routes / Node    │        │  (estado público del sorteo) │
│   - DB: PostgreSQL (Vercel/Neon) │ ─────► │  rifa.json + numbers.json    │
│   - Secrets en Vercel            │publish │  + /images                   │
│   - Webhook Wompi                │        │  + historial de commits      │
└───────────────┬──────────────────┘        └───────────────┬─────────────┘
                ▲                                           │
                │ compra + pago                             │ ISR / rebuild
                │                                           ▼
┌───────────────┴──────────────────┐        ┌─────────────────────────────┐
│   APP CLIENTE Android (APK)      │        │  WEB PÚBLICA (Vercel)        │
│   - Kotlin + Jetpack Compose     │ ◄────► │  - Next.js (SSG/ISR)         │
│   - Compra de números            │  JSON  │  - Lee del repo GitHub raw   │
│   - Sube comprobante manual      │  poll  │  - Muestra números vendidos  │
│   - Wompi Widget (WebView)       │        │  - Muestra ganador           │
└──────────────────────────────────┘        └─────────────────────────────┘
```

### 2.2 Flujos principales

**Flujo A — Crear una rifa nueva (desde la app Admin):**
1. El admin abre la app → “Nueva rifa”.
2. Completa datos (título, descripción, premio, imágenes, rango de números, precio por número, fechas, mínimo de ventas).
3. La app crea un **repositorio nuevo en GitHub** (vía API) y un proyecto en el backend.
4. La web en Vercel se reconstruye/actualiza con los nuevos datos.

**Flujo B — Compra de un número (cliente):**
1. El usuario elige un número libre en la app Android o en la web.
2. Elige método: **Wompi** (Widget Checkout) o **comprobante manual**.
3. Si es Wompi: se abre el widget, paga, Wompi envía **webhook** al backend.
4. Si es manual: sube foto del comprobante; queda **pendiente de aprobación**.
5. El backend **reserva** el número (lock temporal) y, cuando el pago se aprueba, lo marca como **vendido**.

**Flujo C — Aprobación y publicación:**
1. El webhook de Wompi (APPROVED) o el admin aprueba un comprobante.
2. El backend actualiza la base de datos y **publica** el cambio al repo GitHub (commit del estado público).
3. Vercel regenera la página; las apps reflejan el número vendido.

**Flujo D — Cierre y ganador:**
1. El admin cierra ventas y, sobre los números vendidos, **declara el ganador** (mecánica configurable: número específico sorteado o número ingresado validado contra los vendidos).
2. Si no se cumple la condición de sorteo (p. ej., mínimo de ventas no alcanzado, ningún número vendido), se **posterga** y los números/ventas válidas se trasladan al próximo sorteo hasta lograr un ganador.

---

## 3. Stack tecnológico

| Capa | Tecnología | Notas |
| --- | --- | --- |
| Web pública | **Next.js 14+ (App Router)** en **Vercel** | SSG/ISR; lee JSON del repo GitHub vía `raw.githubusercontent.com`. Sin exponer datos sensibles. |
| Backend / API | **Next.js API Routes** o **Node + Fastify** serverless en Vercel | Maneja webhooks Wompi, reservas, aprobaciones, firma de integridad. |
| Base de datos | **PostgreSQL** (Vercel Postgres o Neon) | Tablas transaccionales. El estado público se deriva y publica a GitHub. |
| App Admin Windows | **Tauri** (Rust + WebView) o **Electron** + React/TypeScript | Compila a **MSI** (Tauri: `tauri build` con `wix`; Electron: `electron-builder`). Tauri recomendado por menor tamaño y mejor seguridad. |
| App Android | **Kotlin + Jetpack Compose** (o Flutter como alternativa) | Compila a **APK** firmado. Integra Wompi Widget vía WebView. |
| Pagos | **Wompi Widget Checkout Web** + **Webhooks** | Colombia, COP. Referencia única por intento de pago. |
| Auth | **JWT** (access + refresh) + **TOTP (2FA)** | Hasheado con bcrypt/argon2. |
| CI/CD | **GitHub Actions** | Validación de `rifa.json`, build de APK/MSI, deploy Vercel. |
| Imágenes | Repo GitHub (carpeta `/images`) o **Git LFS** / almacenamiento (Cloudinary/S3) | Las imágenes del catálogo del sorteo. |
| Observabilidad | Logs estructurados + Vercel Analytics + webhook de errores | Auditoría de aprobaciones. |

---

## 4. Modelo de datos

### 4.1 Entidades (PostgreSQL)

```text
RAFFLE (sorteo)
  id, slug, title, description, prize, terms_url,
  number_min, number_max, price_cents, currency (COP),
  starts_at, ends_at, min_sold_to_draw,
  status: DRAFT|ACTIVE|SALES_CLOSED|DRAWN|POSTPONED|ARCHIVED,
  repo_full_name, repo_url, created_by, created_at

TICKET (número de la rifa)
  id, raffle_id, number, status: FREE|RESERVED|SOLD|VOID,
  reserved_until, buyer_pseudonym_id, created_at

BUYER_PROFILE (perfil seudonimizado — lo único público)
  id, display_name,    -- p.ej. "Juan S." (nombre + inicial apellido)
  created_at

PURCHASE (compra)
  id, ticket_id, buyer_profile_id,
  method: WOMPI|MANUAL,
  amount_cents, currency,
  status: PENDING|APPROVED|REJECTED|REFUNDED,
  wompi_reference, wompi_transaction_id,
  manual_receipt_url,   -- acceso privado, nunca público
  purchased_at,         -- hora de compra
  verified_at,          -- hora en que se verificó/aprobó el pago
  approved_by, note

RAFFLE_DRAW (sorteo del ganador)
  id, raffle_id, drawn_at, winning_number, winning_purchase_id,
  mechanism: ADMIN_INPUT|RANDOM_FROM_SOLD, note, status: VALID|VOID

ADMIN_USER
  id, email, password_hash, totp_secret, role, created_at, last_login_at

AUDIT_LOG
  id, actor, action, entity_type, entity_id, before, after, created_at
```

### 4.2 Estado público publicado en GitHub (derivado)

El **único** contenido que se escribe en el repositorio GitHub es un derivado sin datos sensibles:

```jsonc
// repo: <org>/<rafa-slug>  →  /public/raffle.json
{
  "slug": "sorteo-moto-2026",
  "title": "Sorteo Moto 0km",
  "description": "...",
  "prize": "Moto marca X modelo Y",
  "priceCents": 10000,
  "currency": "COP",
  "numberRange": { "min": 0, "max": 999 },
  "startsAt": "2026-07-14T00:00:00-05:00",
  "endsAt": "2026-08-14T23:59:59-05:00",
  "status": "ACTIVE",
  "winner": null
}

// /public/numbers.json  (sólo lo público)
{
  "version": "2026-07-14T12:00:00Z",
  "sold": [
    {
      "number": 42,
      "buyer": "Juan S.",          // nombre + inicial del apellido
      "purchasedAt": "2026-07-14T10:05:00-05:00",
      "verifiedAt": "2026-07-14T10:12:00-05:00"
    }
  ]
}
```

> **Regla de oro:** ningún documento, teléfono, correo, dirección ni la imagen del comprobante se publica en GitHub ni en la web. Esos campos existen **solo** en la base de datos privada y son visibles únicamente para roles autorizados.

---

## 5. Roles y accesos seguros

### 5.1 Roles

| Rol | Ámbito | Permisos |
| --- | --- | --- |
| **Super Admin** | Plataforma | Crea organizaciones/repos, gestiona admins, configura credenciales globales (Wompi, GitHub). |
| **Administrador de sorteo** | Una rifa concreta | Edita datos del sorteo, aprueba/rechaza comprobantes, declara/pospone ganador, publica cambios a GitHub. |
| **Operador / Auditor** | Una rifa concreta | **Solo lectura** sobre compras y comprobantes. Puede exportar reportes. No aprueba ni declara. |
| **Cliente (público)** | Web y app Android | Compra números, sube comprobantes, consulta estado. No accede a datos de otros compradores más allá del seudónimo público. |

### 5.2 Matriz de permisos (resumen)

| Acción | Super Admin | Admin sorteo | Operador | Cliente |
| --- | :--: | :--: | :--: | :--: |
| Crear rifa / repo | ✅ | ✅ (propia) | ❌ | ❌ |
| Editar datos del sorteo | ✅ | ✅ | ❌ | ❌ |
| Ver comprobante (imagen) | ✅ | ✅ | ✅ (lectura) | ❌ |
| Aprobar / rechazar pago | ✅ | ✅ | ❌ | ❌ |
| Publicar cambios a GitHub | ✅ | ✅ | ❌ | ❌ |
| Declarar / posponer ganador | ✅ | ✅ | ❌ | ❌ |
| Exportar reportes | ✅ | ✅ | ✅ | ❌ |
| Comprar números | ❌ | ❌ | ❌ | ✅ |

### 5.3 Controles de acceso

- **Autenticación:** usuario + contraseña (argon2id) + **TOTP 2FA** obligatorio para Super Admin y Admin de sorteo.
- **Sesiones:** JWT de acceso de corta duración (15 min) + refresh token (httpOnly, secure, same-site strict) rotativo.
- **Autorización:** control de acceso por rol en **cada** endpoint del backend (middleware). Comprobación de propiedad del recurso (`raffle_id`).
- **App cliente:** no requiere cuenta para comprar; opcionalmente login ligero para historial. Nunca recibe claves privadas.
- **App Admin:** las credenciales de Wompi/GitHub **no** se almacenan en la app; la app llama al backend, que sí las tiene en variables de entorno.
- **Rate limiting** en endpoints de compra y webhook (Wompi) para mitigar abuso y reintentos maliciosos.
- **Firma de integridad (Wompi):** cada checkout se firma con HMAC-SHA256 usando la llave privada de eventos, para que ni la app ni el cliente puedan manipular monto/referencia.
- **Verificación de webhook Wompi:** validar el header de firma/hash del evento con la llave de eventos antes de confiar en él.
- **Auditoría:** toda acción de admin queda en `AUDIT_LOG` con `before/after`.

---

## 6. Flujo de pago y aprobación

### 6.1 Opción A — Wompi Widget Checkout (web)

1. El cliente selecciona un número libre. El backend genera una **referencia única** (p. ej. `RAFFLE-SLUG-NUM-42-<uuid>`), **reserva** el número por N minutos y devuelve la configuración del widget.
2. Se abre el **Widget Checkout Web** de Wompi:

   ```html
   <script src="https://checkout.wompi.co/widget.js"></script>
   <script>
     const widget = new WidgetCheckout({
       currency: "COP",
       amount: 10000,                 // en centavos
       reference: "RAFFLE-MOTO-42-uuid",
       publicKey: "pub_prod_xxx",     // pública, segura para exponer
       redirectUrl: "https://sorteo.vercel.app/resultado"
       // integrity-signature generada en el backend (HMAC con llave privada)
     });
     widget.render();
   </script>
   ```

   > En la app Android se carga el mismo widget dentro de un **WebView** controlado; la comunicación con la app nativa se hace por `redirectUrl` + verificación en backend.

3. Al finalizar, Wompi redirige al cliente y, **en paralelo**, envía un **webhook** al backend.

### 6.2 Webhook de Wompi (verificación obligatoria)

- Endpoint del backend: `POST /api/webhooks/wompi`.
- **Verificar la firma/hash** del evento usando la llave de eventos de Wompi (variable `WOMPI_EVENTS_KEY`). Rechazar si no coincide.
- Leer `event.data.transaction`:
  - `reference` → localiza la `PURCHASE`.
  - `status`:
    - `APPROVED` → marcar `PURCHASE.status = APPROVED`, `TICKET.status = SOLD`, fijar `verified_at = now()`, registrar el **perfil seudonimizado** y **publicar** el cambio público a GitHub.
    - `DECLINED` / `ERROR` → `PURCHASE.status = REJECTED`, `TICKET.status = FREE` (liberar reserva).
    - `PENDING` → no cambiar el estado de venta hasta confirmación.
- **Idempotencia:** procesar por `wompi_transaction_id`; ignorar duplicados del mismo evento.

### 6.3 Opción B — Comprobante manual

1. El cliente transfiere a la cuenta indicada por el organizador y **sube una imagen del comprobante** desde la app/web.
2. El backend almacena la imagen en almacenamiento **privado** (nunca público ni en el repo) y crea `PURCHASE` con `method = MANUAL`, `status = PENDING`, y reserva el número.
3. El admin (u operador con permiso) revisa el comprobante en la **App Admin** y **aprueba** o **rechaza**:
   - Aprobar → mismo efecto que `APPROVED` de Wompi: `TICKET.status = SOLD`, `verified_at = now()`, publicación pública.
   - Rechazar → `PURCHASE.status = REJECTED`, número liberado, con motivo.

### 6.4 Prevención de doble venta

- **Reserva atómica:** `UPDATE ticket SET status='RESERVED', reserved_until=... WHERE id=? AND status='FREE'` con condición; si 0 filas afectadas, el número ya no estaba libre.
- **Expiración de reservas:** job programado libera números reservados cuya reserva caducó y el pago no llegó.
- Toda transición de estado del ticket va dentro de una **transacción** SQL y queda en `AUDIT_LOG`.

---

## 7. Privacidad por diseño

### 7.1 Qué se publica (GitHub + web pública)

Únicamente, por cada número vendido:

- **Nombre + inicial del apellido** (p. ej., “Juan S.”).
- **Número comprado**.
- **Marca de tiempo de compra** (`purchasedAt`).
- **Marca de tiempo de verificación del pago** (`verifiedAt`).

### 7.2 Qué NUNCA se publica

- Documento de identidad, teléfono, correo, dirección.
- Imagen o datos del comprobante de pago.
- El monto exacto y método a nivel de comprador individual (la web puede mostrar el precio del número, no el detalle financiero de cada comprador).
- Dirección IP, datos de dispositivo del comprador.

### 7.3 Implementación

- Un job de **publicación** genera `numbers.json` a partir de `BUYER_PROFILE` (seudónimo) + `PURCHASE`. Nunca toca las tablas con datos sensibles para la salida pública.
- Reglas de **`.gitignore`** que impiden subir comprobantes u horas privadas.
- Revisión automática en CI: un **GitHub Action** valida que `numbers.json` no contenga campos prohibidos y que cada comprador esté seudonimizado correctamente.
- **Principio de minimización:** la app Android y la web **solo** consumen el JSON público del repo; no tienen acceso a la base de datos.

---

## 8. Sincronización con GitHub y publicación en Vercel

### 8.1 Modelo de repositorio

- Cada **rifa** vive en su propio **repositorio GitHub** (p. ej. `mi-org/sorteo-moto-2026`), creado automáticamente por la App Admin al iniciar el sorteo.
- El repo contiene **solo contenido público**:

  ```
  sorteo-moto-2026/
  ├── public/
  │   ├── raffle.json          # configuración pública del sorteo
  │   ├── numbers.json         # números vendidos (seudonimizados)
  │   └── draw.json            # ganador (cuando exista)
  ├── images/                  # imágenes del catálogo (premio, bases)
  └── README.md
  ```

- El backend escribe en el repo usando un **GitHub App** o un **Personal Access Token fine-grained** con permisos de **contenido** (escritura) **solo** sobre los repos de rifas, nunca sobre el repo del código fuente.

### 8.2 Actualización en cascada

```
Admin aprueba pago  →  Backend actualiza DB
                     →  Backend genera numbers.json
                     →  Backend hace commit+push al repo de la rifa
                     →  Vercel detecta push (webhook) o ISR revalida
                     →  Web pública actualizada
                     →  Apps Android obtienen JSON actualizado (poll / FCM)
```

- **Vercel:** la web puede (a) consumir `raw.githubusercontent.com` con **ISR** (revalidación periódica o por evento), o (b) configurarse para **rebuild** automático ante un push al repo de la rifa (Deploy Hook).
- **Apps Android:** hacen *poll* del JSON público cada N segundos/minutos cuando el sorteo está activo, o reciben notificación push (**FCM**) cuando hay un cambio relevante (nuevo número vendido, ganador declarado).

### 8.3 Validación de cambios (CI)

Un workflow de **GitHub Actions** en cada repo de rifa valida:

- Que `raffle.json` y `numbers.json` cumplan el **JSON Schema** (campos obligatorios, tipos correctos).
- Que `numbers.json` **no** contenga campos privados.
- Que el ganador declarado (en `draw.json`) corresponda a un número efectivamente vendido.

Si la validación falla, el commit queda marcado y se notifica al admin.

---

## 9. Declaración del ganador y postergación

### 9.1 Cierre de ventas

1. El admin cierra las ventas (`RAFFLE.status = SALES_CLOSED`).
2. El sistema verifica el **mínimo de ventas** (`min_sold_to_draw`):
   - Si se cumple, se habilita la declaración del ganador.
   - Si **no** se cumple, el sorteo entra en `POSTPONED` y se aplica la regla de postergación.

### 9.2 Declaración del ganador

Mecánica configurable por sorteo:

- **ADMIN_INPUT:** el admin ingresa el número ganador resultante de su sorteo físico/externo. El backend **valida** que ese número esté `SOLD` (pago aprobado). Si no fue vendido, se rechaza.
- **RANDOM_FROM_SOLD:** el backend sortea aleatoriamente entre los números `SOLD` usando una fuente verificable (p. ej., seed derivado de un hash público + el listado de números vendidos), y registra el mecanismo para auditoría.

Al declarar:

- `RAFFLE_DRAW.winning_number` = número ganador.
- `RAFFLE_DRAW.winning_purchase_id` = compra asociada.
- `RAFFLE.status = DRAWN`.
- Se publica `draw.json` en el repo → la web y las apps muestran el ganador (seudónimo + número).

### 9.3 Regla de postergación

> “Si no se vendió, se posterga hasta el próximo sorteo hasta lograr un ganador que compró el número.”

Implementación:

- Si al cierre **no** hay números vendidos **o** no se alcanza el mínimo, el sorteo pasa a `POSTPONED`.
- Se crea automáticamente el **próximo sorteo** (o la siguiente fecha) y, según la política configurada:
  - **Carry-over de ventas:** las compras aprobadas del sorteo postergado se **mantienen válidas** y se trasladan (mapeo de números) al próximo sorteo, conservando comprador y marcas de tiempo.
  - **Reembolso opcional:** si la política lo indica, se marca para devolución y se notifica a los compradores por su canal privado (sin exponer datos públicamente).
- El ciclo se repite hasta que exista al menos un número vendido y se pueda declarar un ganador válido.

### 9.4 Inmutabilidad y auditoría

- Toda declaración, postergación y traslado de ventas queda en `RAFFLE_DRAW` + `AUDIT_LOG` + historial de commits del repo público. Es posible reconstruir la cronología completa.

---

## 10. Estructura del repositorio (monorepo)

```text
PlataformasSorteosYRifas/
├── apps/
│   ├── admin-windows/      # Tauri/Electron + React → MSI
│   ├── android/            # Kotlin + Jetpack Compose → APK
│   └── web/                # Next.js → Vercel (web pública)
├── packages/
│   ├── api-client/         # Tipos/SDK compartido (TS)
│   ├── schemas/            # JSON Schemas de rifa/numbers/draw
│   └── ui/                 # Componentes compartidos
├── services/
│   └── backend/            # API (Next.js API routes o Node serverless)
├── infra/
│   ├── github-actions/
│   ├── vercel.json
│   └── db/migrations/
├── docs/
│   └── Guia.md             # este archivo
├── .env.example
├── LICENSE                 # MIT
└── README.md
```

---

## 11. Guía de implementación paso a paso (replicable)

> Objetivo: que **otra persona** pueda clonar este repo y lanzar su propio sorteo sin modificar código.

### 11.1 Prerrequisitos

- Cuenta **GitHub** (y un GitHub App o PAT fine-grained para escritura en repos de rifas).
- Cuenta **Vercel**.
- Cuenta **Wompi** (Colombia) en modo **test** primero, luego **producción**.
- Base de datos **PostgreSQL** (Vercel Postgres o Neon).
- Para compilar: Node 20+, JDK 17+ y Android SDK (APK), Rust + Tauri (MSI) en Windows.

### 11.2 Configuración inicial

1. **Clonar y bifurcar** el repositorio base (`fork`).
2. Crear el archivo `.env` a partir de `.env.example` (ver [§13](#13-variables-de-entorno-referencia)).
3. Configurar en Wompi:
   - `publicKey` (`pub_test_` / `pub_prod_`).
   - Llaves privadas para **firma de integridad** y **eventos de webhook**.
   - URL del webhook: `https://<tu-dominio-vercel>/api/webhooks/wompi`.
4. Crear el **GitHub App** o **PAT fine-grained** con permisos de **contenido (read/write)** únicamente sobre los repos de rifas (`sorteo-*` o una organización dedicada).
5. Desplegar el **backend** y la **web** en Vercel.
6. Ejecutar **migraciones** de base de datos (`infra/db/migrations`).
7. Crear el primer **Super Admin** (script de semilla con 2FA).

### 11.3 Crear la primera rifa (desde la App Admin)

1. Instalar el **MSI** e iniciar sesión con el Super/Admin (2FA).
2. “Nueva rifa” → completar datos y subir imágenes.
3. La app crea el **repo GitHub** de la rifa y publica `raffle.json`.
4. Vercel actualiza la web; la URL pública queda lista.
5. Generar el **APK** del cliente (o distribuir el existente) apuntando a la URL pública.

### 11.4 Compilar y distribuir

| Artefacto | Comando | Notas |
| --- | --- | --- |
| Web | `vercel deploy --prod` (o GitHub→Vercel) | Página pública. |
| Admin Windows MSI | `npm run build && tauri build` (Tauri) o `electron-builder --win --msi` | Firmar el instalador si es posible. |
| Android APK | `./gradlew assembleRelease` | Firmar con keystore; distribuir fuera de Play Store si se desea. |

### 11.5 Operación diaria

- Aprobar/rechazar comprobantes manuales desde la App Admin.
- Monitorear webhooks de Wompi (logs + reintentos).
- Al cierre: validar mínimo de ventas, declarar o posponer.

---

## 12. Checklist de seguridad y cumplimiento

- [ ] Todas las claves privadas (Wompi, GitHub, JWT) solo en **variables de entorno**.
- [ ] **2FA** obligatorio para Super Admin y Admin de sorteo.
- [ ] Contraseñas con **argon2id** + política mínima.
- [ ] **HTTPS** obligatorio en todos los servicios.
- [ ] Verificación de **firma de integridad** en cada checkout Wompi.
- [ ] Verificación de **firma/hash de webhook** de Wompi.
- [ ] **Idempotencia** por `wompi_transaction_id`.
- [ ] Reservas de números **atómicas** y con expiración.
- [ ] Validación en CI de que el JSON público **no** contiene datos sensibles.
- [ ] Acceso a comprobantes **privado** y por rol.
- [ ] **Rate limiting** en compra y webhooks.
- [ ] **Backups** y plan de rotación de logs de auditoría.
- [ ] Cumplimiento de normativa local de sorteos/rifas y protección de datos (p. ej., HABEAS DATA en Colombia) y políticas de Wompi.
- [ ] Política de **reembolsos** y **postergación** documentada y comunicada a los compradores.

---

## 13. Variables de entorno (referencia)

```bash
# Backend
DATABASE_URL=postgres://...
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...

# Wompi
WOMPI_PUBLIC_KEY=pub_test_xxx
WOMPI_PRIVATE_KEY=prv_test_xxx          # firma de integridad (server)
WOMPI_EVENTS_KEY=evt_xxx                 # verificación de webhooks
WOMPI_ENV=test                           # test | prod
WOMPI_WEBHOOK_SECRET=...

# GitHub (publicación del estado público de rifas)
GITHUB_APP_ID=...
GITHUB_PRIVATE_KEY=...                   # o GITHUB_TOKEN (fine-grained)
GITHUB_RIFFLES_ORG=mi-org               # repos de rifas: <org>/sorteo-*

# App
NEXT_PUBLIC_WEB_URL=https://sorteo.vercel.app
NEXT_PUBLIC_GITHUB_RAW_BASE=https://raw.githubusercontent.com/<org>
```

---

## 14. Roadmap y extensiones

- **Sorteos aleatorios verificables** (VRF / commit-reveal con hash público).
- **Notificaciones push** (FCM) para venta de número y ganador.
- **Multi-rifa** y dashboard de organizador.
- **Pagos adicionales** (Nequi, PSE, Bancolombia) vía Wompi o pasarelas locales.
- **Internacionalización** (es-CO / en) y monedas múltiples.
- **Modo offline** en la app Android con sincronización diferida.
- **Exportes** para contabilidad/auditoría (CSV/PDF firmados).
- **Panel de transparencia** público: cronología inmutable del sorteo.

---

## 15. Glosario

| Término | Definición |
| --- | --- |
| **Rifa / Sorteo** | Evento en el que se venden números para premiar a uno o más ganadores. |
| **Número / Ticket** | Cada uno de los valores dentro del rango vendible de una rifa. |
| **Seudónimo público** | Representación no sensible de un comprador (nombre + inicial del apellido). |
| **Comprobante** | Imagen/dato que prueba una transferencia manual; acceso privado. |
| **Webhook** | Notificación HTTP de Wompi al backend sobre el estado de una transacción. |
| **ISR** | Incremental Static Regeneration (Next.js): regenera páginas estáticas bajo demanda. |
| **Carry-over** | Traslado de ventas válidas de un sorteo postergado al siguiente. |
| **MSI** | Instalador de Windows. |
| **APK** | Paquete instalable de Android. |

---

> **Cómo replicar esta guía para otro organizador:** clona el repositorio base, completa `.env` con sus credenciales de Wompi/GitHub/Vercel, despliega backend+web, instala el MSI, crea una rifa nueva y distribuye el APK del cliente. Toda la mecánica de venta, aprobación, publicación y declaración de ganador queda operativa sin escribir código.
