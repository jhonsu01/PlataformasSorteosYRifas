// Aplica el esquema contra DATABASE_URL y termina. Idempotente.
//   DATABASE_URL=postgres://... npm run migrate
//
// El arranque normal tambien aplica la migracion, pero tenerlo como paso
// explicito permite ejecutarlo una vez tras crear la base (p. ej. en Neon).

import { createPostgresStore } from "./store-postgres.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL. Ej: DATABASE_URL=postgres://user:pass@host/db npm run migrate");
  process.exit(1);
}

const store = await createPostgresStore(url);
const { rows } = await store._pool.query(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' ORDER BY table_name`
);
console.log("Migraciones aplicadas. Tablas:", rows.map((r) => r.table_name).join(", "));
await store.close();
