// Configuracion desde variables de entorno. Los secretos NUNCA se hardcodean
// (ver .env.example). Todo tiene un default seguro para modo demo/test.

import crypto from "node:crypto";

// Sin JWT_ACCESS_SECRET usamos uno efimero (solo desarrollo). Se marca para que
// el arranque avise/falle en produccion: en serverless cada contenedor generaria
// un secreto distinto y las sesiones se caerian sin explicacion.
const ephemeralJwtSecret = crypto.randomBytes(32).toString("hex");
export const jwtSecretIsEphemeral = !process.env.JWT_ACCESS_SECRET;

export const config = {
  port: Number(process.env.PORT || 8787),

  // Si esta definida, el backend persiste en PostgreSQL; si no, usa memoria
  // (util para demo/desarrollo, pero se pierde al reiniciar).
  databaseUrl: process.env.DATABASE_URL || "",

  // Minutos que un numero queda RESERVED antes de liberarse si no hay pago.
  reserveMinutes: Number(process.env.RESERVE_MINUTES || 15),

  // Siembra la rifa demo. Por defecto SOLO en modo memoria: con una base real
  // (produccion) no se inyectan datos de ejemplo salvo que se pida explicitamente.
  seedDemo: process.env.SEED_DEMO
    ? process.env.SEED_DEMO === "true"
    : !process.env.DATABASE_URL,

  // Protege /api/cron/expire (Vercel Cron envia Authorization: Bearer <CRON_SECRET>).
  cronSecret: process.env.CRON_SECRET || "",

  jwt: {
    // Sin secreto configurado se genera uno aleatorio por proceso: en serverless
    // eso invalida las sesiones en cada arranque en frio -> obligatorio en produccion.
    accessSecret: process.env.JWT_ACCESS_SECRET || ephemeralJwtSecret,
    accessTtl: Number(process.env.JWT_ACCESS_TTL || 900), // 15 min
    refreshTtl: Number(process.env.JWT_REFRESH_TTL || 60 * 60 * 24 * 30), // 30 dias
  },

  wompi: {
    env: process.env.WOMPI_ENV || "test", // test | prod
    publicKey: process.env.WOMPI_PUBLIC_KEY || "",
    // Llave privada de integridad (firma del checkout, lado servidor).
    integrityKey: process.env.WOMPI_PRIVATE_KEY || "",
    // Llave de eventos: verificacion del checksum del webhook.
    eventsKey: process.env.WOMPI_EVENTS_KEY || "",
  },

  github: {
    // PAT fine-grained o token de GitHub App con contenido:write SOLO en repos de rifas.
    token: process.env.GITHUB_TOKEN || "",
    org: process.env.GITHUB_RIFFLES_ORG || "",
    branch: process.env.GITHUB_RIFFLES_BRANCH || "main",
  },
};

export function isGithubConfigured() {
  return Boolean(config.github.token && config.github.org);
}
