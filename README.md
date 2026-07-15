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

## 📖 Replicar para otro organizador

1. Haz *fork* del repo.
2. Copia `.env.example` a `.env` y completa credenciales (Wompi, GitHub, DB).
3. Ajusta `examples/` o publica el `raffle.json` de tu sorteo.
4. Empuja un tag `vX.Y.Z` → obtienes tu APK y MSI en la release.

La guía técnica completa está en [`docs/Guia.md`](docs/Guia.md).

---

## 📄 Licencia

[MIT](LICENSE) — úsalo, modifícalo y distribúyelo libremente.
