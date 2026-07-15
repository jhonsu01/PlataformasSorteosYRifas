// Enrutador de la API, independiente del entorno de ejecucion.
//   - Local:      src/server.js lo envuelve en un http.Server (npm start).
//   - Serverless: api/[...path].js lo exporta como funcion (Vercel).
//
// El store se inicializa de forma perezosa y se CACHEA a nivel de modulo: en
// serverless el contenedor se reutiliza entre invocaciones, asi que no se abre
// un pool nuevo por request.

import { config, jwtSecretIsEphemeral, wompiEnvValid, safeWompiEnv } from "./config.js";
import { createStore } from "./store.js";
import { createPostgresStore } from "./store-postgres.js";
import { verifyEventSignature, actionForStatus, integritySignature } from "./wompi.js";
import { publishPublicState } from "./publisher.js";
import {
  login, refreshSession, logout, requireAuth, requireLevel,
  setupTotp, enableTotp, publicUser,
} from "./auth.js";
import { enforceRateLimit, LIMITS } from "./rate-limit.js";

const DEMO = {
  slug: "sorteo-demo",
  title: "Sorteo Demo — Moto 0km",
  description: "Sorteo de demostracion del framework abierto de Sorteos y Rifas.",
  prize: "Moto 0km marca X modelo Y",
  priceCents: 1000000,
  currency: "COP",
  numberRange: { min: 0, max: 99 },
  startsAt: "2026-07-14T00:00:00-05:00",
  endsAt: "2026-08-14T23:59:59-05:00",
  minSoldToDraw: 20,
  status: "ACTIVE",
};

let storePromise = null;

/** Devuelve el store (una sola vez por contenedor). */
export function getStore() {
  if (!storePromise) {
    storePromise = (async () => {
      const store = config.databaseUrl
        ? await createPostgresStore(config.databaseUrl, { reserveMinutes: config.reserveMinutes })
        : createStore({ reserveMinutes: config.reserveMinutes });
      console.log(`[backend] almacenamiento: ${store.kind}${store.kind === "memory" ? " (sin persistencia)" : ""}`);
      if (jwtSecretIsEphemeral) {
        if (config.databaseUrl) {
          // Con base real esto es produccion: un secreto por contenedor tumbaria
          // las sesiones de forma intermitente e inexplicable.
          throw new Error("Falta JWT_ACCESS_SECRET. Es obligatorio cuando hay DATABASE_URL.");
        }
        console.warn("[backend] AVISO: JWT_ACCESS_SECRET no definido; usando secreto efimero (solo desarrollo).");
      }
      if (!wompiEnvValid) {
        // No se imprime el valor: podria ser un secreto pegado por error.
        console.error(
          `[backend] ERROR: WOMPI_ENV invalido (largo ${config.wompi.env.length}). ` +
          `Debe ser exactamente "test" o "prod". Si pegaste ahi un secreto de Wompi, ROTALO.`
        );
      }
      if (config.seedDemo) await ensureDemo(store);
      return store;
    })();
  }
  return storePromise;
}

/** Siembra la rifa demo solo si no existe (idempotente con PostgreSQL). */
async function ensureDemo(store) {
  let exists = true;
  try { await store.getRaffle(DEMO.slug); } catch { exists = false; }
  if (exists) return;

  await store.createRaffle(DEMO);
  const mk = async (n, firstName, lastName, phone, approve) => {
    const p = await store.reserve(DEMO.slug, n, { firstName, lastName, phone, email: `${firstName.toLowerCase()}@correo.com` }, "MANUAL");
    await store.attachReceipt(p.id, `private://comprobantes/${p.id}.jpg`);
    if (approve) await store.approve(p.id, { approvedBy: "seed" });
  };
  await mk(7, "Juan", "Sanchez", "3001112233", true);
  await mk(12, "Maria", "Perez", "3002223344", true);
  await mk(23, "Carlos", "Ramirez", "3003334455", true);
  await mk(15, "Luis", "Gomez", "3004445566", false);
  await mk(27, "Sofia", "Vargas", "3005556677", false);
  await mk(48, "Andres", "Torres", "3006667788", false);
  console.log("[backend] rifa demo sembrada");
}

// ---------------------------------------------------------------------------
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const json = (res, status, obj) => {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

async function readBody(req) {
  // En Vercel el body puede venir ya parseado.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "object") return req.body;
    try { return JSON.parse(req.body); } catch { throw Object.assign(new Error("JSON invalido"), { status: 400 }); }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON invalido"), { status: 400 });
  }
}

async function maybePublish(store, slug, draw = null) {
  try {
    return await publishPublicState(store, slug, { draw });
  } catch (e) {
    console.error("[publish] error:", e.message);
    return { published: false, reason: e.message };
  }
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
export async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

    const url = new URL(req.url, "http://localhost");
    // Ruta efectiva: en Vercel el rewrite manda todo a /api/index y pasa la ruta
    // original en `__path`; en local (http.Server) req.url ya es la ruta real.
    // Resolverlo asi funciona en ambos entornos sin depender de como Vercel
    // reescriba req.url.
    const pathname = url.searchParams.get("__path") || url.pathname;
    const parts = pathname.split("/").filter(Boolean);
    const M = req.method;

    // /health y /api/health
    if (M === "GET" && (pathname === "/health" || pathname === "/api/health")) {
      const store = await getStore();
      return json(res, 200, {
        ok: true,
        // Nunca el valor crudo: si WOMPI_ENV trae un secreto por error, /health
        // lo publicaria a internet. Solo se expone "test" | "prod" | "invalido".
        env: safeWompiEnv(),
        envValid: wompiEnvValid,
        storage: store.kind,
        wompiConfigured: Boolean(config.wompi.publicKey),
        wompiIntegrityConfigured: Boolean(config.wompi.integrityKey),
        wompiEventsConfigured: Boolean(config.wompi.eventsKey),
        githubConfigured: Boolean(config.github.token && config.github.org),
      });
    }

    // Cron de Vercel: libera reservas vencidas.
    if (parts[0] === "api" && parts[1] === "cron" && parts[2] === "expire") {
      if (config.cronSecret) {
        const auth = req.headers?.authorization || "";
        if (auth !== `Bearer ${config.cronSecret}`) return json(res, 401, { error: "No autorizado" });
      }
      const store = await getStore();
      const freed = await store.expireReservations();
      const limpiados = await store.cleanupRateLimits();
      return json(res, 200, { ok: true, freed, rateLimitsLimpiados: limpiados });
    }

    const store = await getStore();

    // ---------------- Autenticacion ----------------
    if (parts[0] === "api" && parts[1] === "auth") {
      if (M === "POST" && parts[2] === "login") {
        // Frena la fuerza bruta de contrasenas.
        await enforceRateLimit(store, req, LIMITS.login);
        const b = await readBody(req);
        try {
          return json(res, 200, await login(store, b));
        } catch (e) {
          // Distingue "falta el 2FA" de "credenciales malas" sin revelar cual.
          if (e.totpRequired) return json(res, 401, { error: e.message, totpRequired: true });
          throw e;
        }
      }
      if (M === "POST" && parts[2] === "refresh") {
        const b = await readBody(req);
        return json(res, 200, await refreshSession(store, b.refreshToken));
      }
      if (M === "POST" && parts[2] === "logout") {
        const b = await readBody(req);
        return json(res, 200, await logout(store, b.refreshToken));
      }
      if (M === "GET" && parts[2] === "me") {
        const user = await requireAuth(req, store);
        return json(res, 200, { user: publicUser(user) });
      }
      if (M === "POST" && parts[2] === "totp" && parts[3] === "setup") {
        const user = await requireAuth(req, store);
        return json(res, 200, await setupTotp(store, user));
      }
      if (M === "POST" && parts[2] === "totp" && parts[3] === "enable") {
        const user = await requireAuth(req, store);
        const b = await readBody(req);
        return json(res, 200, await enableTotp(store, user, b.code));
      }
    }

    if (M === "GET" && parts[0] === "api" && parts[1] === "raffles" && parts.length === 2) {
      return json(res, 200, { raffles: await store.listRaffles() });
    }

    if (M === "POST" && parts[0] === "api" && parts[1] === "raffles" && parts.length === 2) {
      const user = requireLevel(await requireAuth(req, store), "ADMIN");
      const b = await readBody(req);
      if (!b.slug || !SLUG_RE.test(b.slug)) return json(res, 400, { error: "slug invalido (usa minusculas-con-guiones)" });
      if (!b.title || !b.prize) return json(res, 400, { error: "title y prize requeridos" });
      const min = Number(b.numberRange?.min ?? 0);
      const max = Number(b.numberRange?.max ?? 0);
      if (!(max >= min)) return json(res, 400, { error: "numberRange.max debe ser >= min" });
      const raffle = await store.createRaffle({
        slug: b.slug, title: b.title, description: b.description || "", prize: b.prize,
        priceCents: Number(b.priceCents || 0), currency: "COP",
        numberRange: { min, max },
        startsAt: b.startsAt || new Date().toISOString(),
        endsAt: b.endsAt || new Date(Date.now() + 30 * 864e5).toISOString(),
        minSoldToDraw: Number(b.minSoldToDraw || 0), status: "ACTIVE",
      });
      await store.audit({ actor: user.email, action: "CREATE_RAFFLE", entityType: "raffle", entityId: raffle.slug, after: raffle });
      const pub = await maybePublish(store, raffle.slug);
      return json(res, 201, { raffle: await store.publicRaffle(raffle.slug), published: pub.published });
    }

    if (M === "GET" && parts[0] === "api" && parts[1] === "raffles" && parts[3] === "public") {
      const slug = parts[2];
      if (parts[4] === "raffle.json") return json(res, 200, await store.publicRaffle(slug));
      if (parts[4] === "numbers.json") return json(res, 200, await store.publicNumbers(slug));
    }

    // Contiene datos de contacto privados -> solo roles autorizados (Guia 5.2).
    if (M === "GET" && parts[0] === "api" && parts[1] === "raffles" && parts[3] === "purchases") {
      requireLevel(await requireAuth(req, store), "OPERATOR");
      const slug = parts[2];
      await store.getRaffle(slug);
      return json(res, 200, { purchases: await store.adminPurchases(slug, url.searchParams.get("status") || null) });
    }

    if (M === "GET" && parts[0] === "api" && parts[1] === "purchases" && parts.length === 3) {
      const p = await store.getPurchase(parts[2]);
      return json(res, 200, {
        id: p.id, slug: p.slug, number: p.number,
        status: p.status, verifiedAt: p.verifiedAt, reference: p.reference,
      });
    }

    if (M === "GET" && parts[0] === "api" && parts[1] === "checkout" && parts[2] === "signature") {
      const reference = url.searchParams.get("reference");
      const amount = url.searchParams.get("amount");
      const currency = url.searchParams.get("currency") || "COP";
      if (!reference || !amount) return json(res, 400, { error: "reference y amount requeridos" });
      return json(res, 200, {
        reference, amount, currency,
        signature: integritySignature(reference, amount, currency, config.wompi.integrityKey),
      });
    }

    if (M === "POST" && parts[0] === "api" && parts[1] === "raffles" && parts[3] === "reserve") {
      // Sin esto, un script podria reservar TODOS los numeros de la rifa (cada
      // reserva bloquea el numero RESERVE_MINUTES) sin pagar un peso.
      await enforceRateLimit(store, req, { ...LIMITS.reserve, extra: parts[2] });
      const b = await readBody(req);
      if (typeof b.number !== "number" || !b.buyer?.firstName) {
        return json(res, 400, { error: "number y buyer.firstName requeridos" });
      }
      const p = await store.reserve(parts[2], b.number, b.buyer, b.method || "MANUAL");
      return json(res, 201, {
        purchaseId: p.id, number: p.number, reference: p.reference,
        amountInCents: p.amountCents, currency: "COP",
        publicKey: config.wompi.publicKey,
        integritySignature: integritySignature(p.reference, String(p.amountCents), "COP", config.wompi.integrityKey),
        status: p.status,
      });
    }

    if (M === "POST" && parts[0] === "api" && parts[1] === "purchases" && parts[3] === "receipt") {
      const b = await readBody(req);
      const p = await store.attachReceipt(parts[2], b.receiptUrl);
      return json(res, 200, { purchaseId: p.id, status: p.status });
    }

    // Aprobar vende el numero: solo ADMIN+ (un abierto aqui = numeros vendidos sin pagar).
    if (M === "POST" && parts[0] === "api" && parts[1] === "purchases" && parts[3] === "approve") {
      const user = requireLevel(await requireAuth(req, store), "ADMIN");
      const p = await store.approve(parts[2], { approvedBy: user.email });
      await store.audit({ actor: user.email, action: "APPROVE_PURCHASE", entityType: "purchase", entityId: p.id, after: { number: p.number, status: p.status } });
      const pub = await maybePublish(store, p.slug);
      return json(res, 200, { purchaseId: p.id, status: p.status, verifiedAt: p.verifiedAt, published: pub.published });
    }

    if (M === "POST" && parts[0] === "api" && parts[1] === "purchases" && parts[3] === "reject") {
      const user = requireLevel(await requireAuth(req, store), "ADMIN");
      const b = await readBody(req);
      const p = await store.reject(parts[2], { reason: b.reason || "" });
      await store.audit({ actor: user.email, action: "REJECT_PURCHASE", entityType: "purchase", entityId: p.id, after: { number: p.number, reason: b.reason || "" } });
      return json(res, 200, { purchaseId: p.id, status: p.status });
    }

    // Declarar ganador: solo ADMIN+ (un abierto aqui = cualquiera se auto-declara ganador).
    if (M === "POST" && parts[0] === "api" && parts[1] === "raffles" && parts[3] === "draw") {
      const user = requireLevel(await requireAuth(req, store), "ADMIN");
      const b = await readBody(req);
      const draw = await store.declareWinner(parts[2], b.number, b.mechanism || "ADMIN_INPUT");
      await store.audit({ actor: user.email, action: "DECLARE_WINNER", entityType: "raffle", entityId: parts[2], after: draw });
      const pub = await maybePublish(store, parts[2], draw);
      return json(res, 200, { ...draw, published: pub.published });
    }

    if (M === "POST" && parts[0] === "api" && parts[1] === "webhooks" && parts[2] === "wompi") {
      // Limite alto a proposito: Wompi reintenta los eventos y perder uno
      // significa perder una venta. La firma ya garantiza la autenticidad;
      // esto solo evita que una inundacion agote las invocaciones.
      await enforceRateLimit(store, req, LIMITS.webhook);
      const event = await readBody(req);
      if (config.wompi.eventsKey) {
        if (!verifyEventSignature(event, config.wompi.eventsKey)) {
          return json(res, 401, { error: "Firma de webhook invalida" });
        }
      }
      const tx = event?.data?.transaction;
      if (!tx?.reference) return json(res, 400, { error: "Evento sin transaction.reference" });
      if (await store.alreadyProcessed(tx.id)) return json(res, 200, { idempotent: true });
      await store.markProcessed(tx.id);
      const purchase = await store.findByReference(tx.reference);
      if (!purchase) return json(res, 200, { ignored: true, reason: "reference desconocida" });
      const action = actionForStatus(tx.status);
      if (action === "SELL") {
        await store.markSold(purchase, { approvedBy: "wompi", wompiTransactionId: tx.id });
        const pub = await maybePublish(store, purchase.slug);
        return json(res, 200, { ok: true, action, published: pub.published });
      }
      if (action === "RELEASE") {
        await store.reject(purchase.id, { reason: `Wompi ${tx.status}` });
        return json(res, 200, { ok: true, action });
      }
      return json(res, 200, { ok: true, action: "WAIT" });
    }

    return json(res, 404, { error: "Ruta no encontrada" });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    // 429 debe decir cuando reintentar (cabecera estandar).
    if (e.retryAfter) res.setHeader("Retry-After", String(e.retryAfter));
    return json(res, status, { error: e.message });
  }
}

export { DEMO };
