# Infraestructura

- **Despliegue:** ver [`docs/DEPLOY.md`](../docs/DEPLOY.md) — backend en Vercel + PostgreSQL
  en Neon + webhook de Wompi.
- **Migraciones:** viven junto al servicio en
  [`services/backend/migrations/`](../services/backend/migrations/) para que viajen con el
  despliegue serverless (`vercel.json` las incluye vía `includeFiles`). Se aplican con
  `npm run migrate` o automáticamente al arrancar (son idempotentes).
- **Config de Vercel del backend:** [`services/backend/vercel.json`](../services/backend/vercel.json)
  (catch-all `api/**`, rewrite de `/health` y cron de liberación de reservas).
- **Workflows activos:** [`.github/workflows/`](../.github/workflows/) — CI (validación de
  JSON público + pruebas contra PostgreSQL real) y Release (APK + MSI).

`github-actions/` queda como espacio para plantillas destinadas a los repos de cada rifa.
