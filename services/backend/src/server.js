// Servidor HTTP del backend. Persiste en PostgreSQL si DATABASE_URL esta
// definida; si no, usa el store en memoria (demo). Todas las llamadas al store
// se hacen con await para soportar ambos drivers.

import http from "node:http";
import { config } from "./config.js";
import { createStore } from "./store.js";
import { createPostgresStore } from "./store-postgres.js";
import { verifyEventSignature, actionForStatus, integritySignature } from "./wompi.js";
import { publishPublicState } from "./publisher.js";

// --- Seleccion de almacenamiento (top-level await, ESM) ---
const store = config.databaseUrl
  ? await createPostgresStore(config.databaseUrl, { reserveMinutes: config.reserveMinutes })
  : createStore({ reserveMinutes: config.reserveMinutes });

console.log(`[backend] almacenamiento: ${store.kind}${store.kind === "memory" ? " (sin persistencia)" : ""}`);

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

// Siembra la rifa demo SOLO la primera vez (con PostgreSQL no se duplica).
async function ensureDemo() {
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

// Libera reservas expiradas cada minuto.
setInterval(() => store.expireReservations().catch(() => {}), 60_000).unref?.();

// ---------------------------------------------------------------------------
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const json = (res, status, obj) => {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON invalido"), { status: 400 });
  }
}

async function maybePublish(slug, draw = null) {
  try {
    return await publishPublicState(store, slug, { draw });
  } catch (e) {
    console.error("[publish] error:", e.message);
    return { published: false, reason: e.message };
  }
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

    const url = new URL(req.url, `http://localhost:${config.port}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const M = req.method;

    if (M === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        env: config.wompi.env,
        storage: store.kind,
        wompiConfigured: Boolean(config.wompi.publicKey),
        githubConfigured: Boolean(config.github.token && config.github.org),
      });
    }

    if (M === "GET" && parts[0] === "api" && parts[1] === "raffles" && parts.length === 2) {
      return json(res, 200, { raffles: await store.listRaffles() });
    }

    if (M === "POST" && parts[0] === "api" && parts[1] === "raffles" && parts.length === 2) {
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
      const pub = await maybePublish(raffle.slug);
      return json(res, 201, { raffle: await store.publicRaffle(raffle.slug), published: pub.published });
    }

    if (M === "GET" && parts[0] === "api" && parts[1] === "raffles" && parts[3] === "public") {
      const slug = parts[2];
      if (parts[4] === "raffle.json") return json(res, 200, await store.publicRaffle(slug));
      if (parts[4] === "numbers.json") return json(res, 200, await store.publicNumbers(slug));
    }

    if (M === "GET" && parts[0] === "api" && parts[1] === "raffles" && parts[3] === "purchases") {
      const slug = parts[2];
      await store.getRaffle(slug);
      const status = url.searchParams.get("status") || null;
      return json(res, 200, { purchases: await store.adminPurchases(slug, status) });
    }

    // GET /api/purchases/:id  -> estado de una compra (lo consulta el APK tras pagar).
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
      const slug = parts[2];
      const b = await readBody(req);
      if (typeof b.number !== "number" || !b.buyer?.firstName) {
        return json(res, 400, { error: "number y buyer.firstName requeridos" });
      }
      const p = await store.reserve(slug, b.number, b.buyer, b.method || "MANUAL");
      const amount = String(p.amountCents);
      return json(res, 201, {
        purchaseId: p.id, number: p.number, reference: p.reference,
        amountInCents: p.amountCents, currency: "COP",
        publicKey: config.wompi.publicKey,
        integritySignature: integritySignature(p.reference, amount, "COP", config.wompi.integrityKey),
        status: p.status,
      });
    }

    if (M === "POST" && parts[0] === "api" && parts[1] === "purchases" && parts[3] === "receipt") {
      const b = await readBody(req);
      const p = await store.attachReceipt(parts[2], b.receiptUrl);
      return json(res, 200, { purchaseId: p.id, status: p.status });
    }

    if (M === "POST" && parts[0] === "api" && parts[1] === "purchases" && parts[3] === "approve") {
      const b = await readBody(req);
      const p = await store.approve(parts[2], { approvedBy: b.approvedBy || "admin" });
      const pub = await maybePublish(p.slug);
      return json(res, 200, { purchaseId: p.id, status: p.status, verifiedAt: p.verifiedAt, published: pub.published });
    }

    if (M === "POST" && parts[0] === "api" && parts[1] === "purchases" && parts[3] === "reject") {
      const b = await readBody(req);
      const p = await store.reject(parts[2], { reason: b.reason || "" });
      return json(res, 200, { purchaseId: p.id, status: p.status });
    }

    if (M === "POST" && parts[0] === "api" && parts[1] === "raffles" && parts[3] === "draw") {
      const slug = parts[2];
      const b = await readBody(req);
      const draw = await store.declareWinner(slug, b.number, b.mechanism || "ADMIN_INPUT");
      const pub = await maybePublish(slug, draw);
      return json(res, 200, { ...draw, published: pub.published });
    }

    if (M === "POST" && parts[0] === "api" && parts[1] === "webhooks" && parts[2] === "wompi") {
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
        const pub = await maybePublish(purchase.slug);
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
    return json(res, status, { error: e.message });
  }
});

await ensureDemo();
server.listen(config.port, () => {
  console.log(`[backend] escuchando en http://localhost:${config.port} (Wompi ${config.wompi.env})`);
  console.log(`[backend] rifa demo: GET /api/raffles/${DEMO.slug}/public/numbers.json`);
});

export { server, store };
