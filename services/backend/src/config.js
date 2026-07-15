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

  // Rate limiting (0 = desactivado). Ver src/rate-limit.js.
  rateLimit: {
    reserve: Number(process.env.RATE_LIMIT_RESERVE ?? 15),  // por IP / 10 min
    login: Number(process.env.RATE_LIMIT_LOGIN ?? 10),      // por IP / 10 min
    webhook: Number(process.env.RATE_LIMIT_WEBHOOK ?? 120), // por IP / 1 min
  },

  jwt: {
    // Sin secreto configurado se genera uno aleatorio por proceso: en serverless
    // eso invalida las sesiones en cada arranque en frio -> obligatorio en produccion.
    accessSecret: process.env.JWT_ACCESS_SECRET || ephemeralJwtSecret,
    accessTtl: Number(process.env.JWT_ACCESS_TTL || 900), // 15 min
    refreshTtl: Number(process.env.JWT_REFRESH_TTL || 60 * 60 * 24 * 30), // 30 dias
  },

  wompi: {
    // SOLO "test" o "prod". Nunca un secreto (ver wompiEnvValid).
    env: (process.env.WOMPI_ENV || "test").trim(),

    // Llave publica: pub_test_... / pub_prod_...  (segura de exponer)
    publicKey: (process.env.WOMPI_PUBLIC_KEY || "").trim(),

    // Secreto de INTEGRIDAD: test_integrity_... / prod_integrity_...
    // OJO: NO es la "llave privada" prv_test_ de Wompi (esa es para su API REST).
    // WOMPI_PRIVATE_KEY se mantiene como alias por compatibilidad.
    integrityKey: (process.env.WOMPI_INTEGRITY_SECRET || process.env.WOMPI_PRIVATE_KEY || "").trim(),

    // Secreto de EVENTOS: test_events_... / prod_events_...  (verifica el webhook)
    eventsKey: (process.env.WOMPI_EVENTS_KEY || "").trim(),
  },

  github: {
    // PAT (o GitHub App) con contenido:write sobre los repos de rifas.
    //
    // OJO: usa GITHUB_RIFFLES_TOKEN, no GITHUB_TOKEN. En Vercel se comprobo que
    // GITHUB_TOKEN NO llega a la funcion (GITHUB_RIFFLES_OWNER, definida a la vez
    // y en el mismo entorno, si llegaba): la plataforma trata ese nombre de forma
    // especial. GITHUB_TOKEN se mantiene como fallback para otros entornos.
    // .trim() no es cosmetico: un salto de linea o espacio al pegar el valor en
    // el panel viaja hasta la cabecera `Bearer <token>` y GitHub responde 401
    // sin decir por que. Lo mismo con el owner en la URL.
    token: (process.env.GITHUB_RIFFLES_TOKEN || process.env.GITHUB_TOKEN || "").trim(),
    // Cuenta personal (p. ej. "jhonsu01") u organizacion donde viven los repos
    // de cada rifa. GITHUB_RIFFLES_ORG se mantiene como alias antiguo.
    owner: (process.env.GITHUB_RIFFLES_OWNER || process.env.GITHUB_RIFFLES_ORG || "").trim(),
    branch: (process.env.GITHUB_RIFFLES_BRANCH || "main").trim(),
  },
};

export function isGithubConfigured() {
  return Boolean(config.github.token && config.github.owner);
}

/** WOMPI_ENV solo admite "test" o "prod". */
export const wompiEnvValid = ["test", "prod"].includes(config.wompi.env);

/**
 * Valor de entorno seguro para exponer en /health.
 * Nunca devuelve el contenido crudo de WOMPI_ENV: si alguien pega ahi un secreto
 * por error, /health lo publicaria a internet (paso de verdad).
 */
export const safeWompiEnv = () => (wompiEnvValid ? config.wompi.env : "invalido");
