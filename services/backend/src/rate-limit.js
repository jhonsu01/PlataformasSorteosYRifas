// Rate limiting por ventana fija, contado en la base (ver migrations/003).
//
// Nota sobre los limites: en Colombia el trafico movil sale por CGNAT, asi que
// muchos compradores legitimos COMPARTEN IP. Por eso los limites son generosos:
// buscan frenar un script (reservar los 1000 numeros, fuerza bruta de claves)
// sin bloquear a varias personas tras la misma IP.

import { config } from "./config.js";
import { httpError } from "./store.js";

/** IP real del cliente detras del proxy de Vercel. */
export function clientIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return (
    req.headers?.["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "desconocida"
  );
}

/**
 * Cuenta un intento y lanza 429 si se pasa del limite.
 * @param extra discriminador opcional (p. ej. el slug o el correo)
 */
export async function enforceRateLimit(store, req, { name, limit, windowSec, extra = "" }) {
  if (!limit || limit <= 0) return { skipped: true };

  const ip = clientIp(req);
  const now = Date.now();
  // Ventana fija: todas las peticiones del mismo intervalo caen en el mismo bucket.
  const windowStart = Math.floor(now / 1000 / windowSec) * windowSec;
  const bucket = `${name}:${extra}:${ip}:${windowStart}`;
  const expiresAt = new Date((windowStart + windowSec) * 1000);

  const hits = await store.hitRateLimit(bucket, expiresAt);
  if (hits > limit) {
    const retryAfter = Math.max(1, Math.ceil((expiresAt.getTime() - now) / 1000));
    const e = httpError(429, `Demasiadas peticiones. Reintenta en ${retryAfter} segundos.`);
    e.retryAfter = retryAfter;
    throw e;
  }
  return { hits, limit, remaining: Math.max(0, limit - hits) };
}

// Limites por endpoint (configurables por entorno).
export const LIMITS = {
  // Reservar bloquea un numero durante RESERVE_MINUTES: es el abuso mas danino
  // (un script podria dejar la rifa entera sin numeros libres sin pagar nada).
  reserve: { name: "reserve", limit: config.rateLimit.reserve, windowSec: 600 },
  // Fuerza bruta de contrasenas.
  login: { name: "login", limit: config.rateLimit.login, windowSec: 600 },
  // Generoso: Wompi reintenta los eventos y no queremos perder pagos.
  // La firma ya protege la autenticidad; esto solo frena inundaciones.
  webhook: { name: "webhook", limit: config.rateLimit.webhook, windowSec: 60 },
};
