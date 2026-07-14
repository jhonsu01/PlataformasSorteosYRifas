// Servidor HTTP del backend (sin dependencias). Expone reservas, aprobacion,
// webhook de Wompi y consulta del estado publico. En produccion se despliega
// serverless (Vercel) o detras de un reverse proxy con HTTPS.

import http from "node:http";
import { config } from "./config.js";
import { createStore } from "./store.js";
import { verifyEventSignature, actionForStatus, integritySignature } from "./wompi.js";
import { publishPublicState } from "./publisher.js";

const store = createStore({ reserveMinutes: config.reserveMinutes });

// Rifa demo sembrada al arrancar (para poder probar de inmediato).
store.createRaffle({
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
});

// Libera reservas expiradas cada minuto.
setInterval(() => store.expireReservations(), 60_000).unref?.();

// ---------------------------------------------------------------------------
const json = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
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

// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${config.port}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const M = req.method;

    // GET /health
    if (M === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, env: config.wompi.env });
    }

    // GET /api/raffles/:slug/public/(raffle|numbers).json
    if (M === "GET" && parts[0] === "api" && parts[1] === "raffles" && parts[3] === "public") {
      const slug = parts[2];
      if (parts[4] === "raffle.json") return json(res, 200, store.publicRaffle(slug));
      if (parts[4] === "numbers.json") return json(res, 200, store.publicNumbers(slug));
    }

    // GET /api/checkout/signature?reference=&amount=&currency=COP
    if (M === "GET" && parts[0] === "api" && parts[1] === "checkout" && parts[2] === "signature") {
      const reference = url.searchParams.get("reference");
      const amount = url.searchParams.get("amount");
      const currency = url.searchParams.get("currency") || "COP";
      if (!reference || !amount) return json(res, 400, { error: "reference y amount requeridos" });
      const signature = integritySignature(reference, amount, currency, config.wompi.integrityKey);
      return json(res, 200, { reference, amount, currency, signature });
    }

    // POST /api/raffles/:slug/reserve  { number, buyer:{firstName,lastName,phone?,email?}, method? }
    if (M === "POST" && parts[0] === "api" && parts[1] === "raffles" && parts[3] === "reserve") {
      const slug = parts[2];
      const b = await readBody(req);
      if (typeof b.number !== "number" || !b.buyer?.firstName) {
        return json(res, 400, { error: "number y buyer.firstName requeridos" });
      }
      const p = store.reserve(slug, b.number, b.buyer, b.method || "MANUAL");
      const amount = String(p.amountCents);
      const signature = integritySignature(p.reference, amount, "COP", config.wompi.integrityKey);
      // Devuelve la config para el Widget de Wompi (sin exponer datos privados).
      return json(res, 201, {
        purchaseId: p.id,
        number: p.number,
        reference: p.reference,
        amountInCents: p.amountCents,
        currency: "COP",
        publicKey: config.wompi.publicKey,
        integritySignature: signature,
        status: p.status,
      });
    }

    // POST /api/purchases/:id/receipt  { receiptUrl }
    if (M === "POST" && parts[0] === "api" && parts[1] === "purchases" && parts[3] === "receipt") {
      const b = await readBody(req);
      const p = store.attachReceipt(parts[2], b.receiptUrl);
      return json(res, 200, { purchaseId: p.id, status: p.status });
    }

    // POST /api/purchases/:id/approve  { approvedBy? }  (aprobacion manual)
    if (M === "POST" && parts[0] === "api" && parts[1] === "purchases" && parts[3] === "approve") {
      const b = await readBody(req);
      const p = store.approve(parts[2], { approvedBy: b.approvedBy || "admin" });
      const pub = await maybePublish(p.slug);
      return json(res, 200, { purchaseId: p.id, status: p.status, verifiedAt: p.verifiedAt, published: pub.published });
    }

    // POST /api/purchases/:id/reject  { reason? }
    if (M === "POST" && parts[0] === "api" && parts[1] === "purchases" && parts[3] === "reject") {
      const b = await readBody(req);
      const p = store.reject(parts[2], { reason: b.reason || "" });
      return json(res, 200, { purchaseId: p.id, status: p.status });
    }

    // POST /api/raffles/:slug/draw  { number, mechanism? }
    if (M === "POST" && parts[0] === "api" && parts[1] === "raffles" && parts[3] === "draw") {
      const slug = parts[2];
      const b = await readBody(req);
      const draw = store.declareWinner(slug, b.number, b.mechanism || "ADMIN_INPUT");
      const pub = await maybePublish(slug, draw);
      return json(res, 200, { ...draw, published: pub.published });
    }

    // POST /api/webhooks/wompi  (evento de Wompi)
    if (M === "POST" && parts[0] === "api" && parts[1] === "webhooks" && parts[2] === "wompi") {
      const event = await readBody(req);
      // 1) Verificar firma (si hay llave de eventos configurada).
      if (config.wompi.eventsKey) {
        if (!verifyEventSignature(event, config.wompi.eventsKey)) {
          return json(res, 401, { error: "Firma de webhook invalida" });
        }
      }
      const tx = event?.data?.transaction;
      if (!tx?.reference) return json(res, 400, { error: "Evento sin transaction.reference" });

      // 2) Idempotencia por id de transaccion.
      if (store.alreadyProcessed(tx.id)) return json(res, 200, { idempotent: true });
      store.markProcessed(tx.id);

      const purchase = store.findByReference(tx.reference);
      if (!purchase) return json(res, 200, { ignored: true, reason: "reference desconocida" });

      // 3) Aplicar segun estado.
      const action = actionForStatus(tx.status);
      if (action === "SELL") {
        store.markSold(purchase, { approvedBy: "wompi", wompiTransactionId: tx.id });
        const pub = await maybePublish(purchase.slug);
        return json(res, 200, { ok: true, action, published: pub.published });
      }
      if (action === "RELEASE") {
        store.reject(purchase.id, { reason: `Wompi ${tx.status}` });
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

// Solo arranca si se ejecuta directamente (no al importar en tests).
const isMain = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("server.js");
if (isMain) {
  server.listen(config.port, () => {
    console.log(`[backend] escuchando en http://localhost:${config.port} (Wompi ${config.wompi.env})`);
    console.log(`[backend] rifa demo: GET /api/raffles/sorteo-demo/public/numbers.json`);
  });
}

export { server, store };
