# Infraestructura

Configuración de despliegue e infraestructura:

- `vercel.json` — configuración de la web pública (ISR / deploy hooks).
- `db/migrations/` — migraciones de PostgreSQL del backend.
- `github-actions/` — plantillas y utilidades para los repos de rifas.

Se completa a medida que se conectan el backend y el despliegue en Vercel.
Los workflows activos del monorepo están en [`.github/workflows/`](../.github/workflows/).
