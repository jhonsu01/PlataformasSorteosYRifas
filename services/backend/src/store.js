// Modelo de datos en memoria (reemplazable por PostgreSQL en produccion).
// Regla de oro: los datos privados (telefono, correo, documento, comprobante)
// viven SOLO en el objeto `private` de cada compra y NUNCA salen al estado publico.

import crypto from "node:crypto";

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function cap(s) {
  const v = String(s || "").trim();
  return v ? v[0].toUpperCase() + v.slice(1).toLowerCase() : v;
}

// Seudonimo publico: "Nombre I." (nombre + inicial del apellido). Nada mas.
export function pseudonym(firstName, lastName) {
  const f = cap(firstName);
  const l = String(lastName || "").trim();
  return l ? `${f} ${l[0].toUpperCase()}.` : f;
}

export function createStore({ reserveMinutes = 15 } = {}) {
  const reserveMs = reserveMinutes * 60 * 1000;
  const raffles = new Map(); // slug -> raffle
  const tickets = new Map(); // `${slug}#${n}` -> ticket
  const purchases = new Map(); // id -> purchase
  const byReference = new Map(); // reference -> purchaseId
  const processedTx = new Set(); // idempotencia webhook (wompi_transaction_id)

  const key = (slug, n) => `${slug}#${n}`;

  function createRaffle(cfg) {
    if (raffles.has(cfg.slug)) return raffles.get(cfg.slug);
    const raffle = {
      slug: cfg.slug,
      title: cfg.title,
      description: cfg.description || "",
      prize: cfg.prize,
      priceCents: cfg.priceCents,
      currency: cfg.currency || "COP",
      numberRange: cfg.numberRange,
      startsAt: cfg.startsAt,
      endsAt: cfg.endsAt,
      minSoldToDraw: cfg.minSoldToDraw ?? 0,
      status: cfg.status || "ACTIVE",
      winner: null,
    };
    raffles.set(cfg.slug, raffle);
    for (let n = cfg.numberRange.min; n <= cfg.numberRange.max; n++) {
      tickets.set(key(cfg.slug, n), {
        slug: cfg.slug, number: n, status: "FREE", reservedUntil: null, purchaseId: null,
      });
    }
    return raffle;
  }

  function getRaffle(slug) {
    const r = raffles.get(slug);
    if (!r) throw httpError(404, "Rifa no encontrada");
    return r;
  }

  // Reserva ATOMICA: solo pasa de FREE -> RESERVED. Como Node ejecuta el event
  // loop de forma sincronica, el check-and-set no tiene condicion de carrera.
  function reserve(slug, number, buyer, method = "MANUAL") {
    getRaffle(slug);
    const t = tickets.get(key(slug, number));
    if (!t) throw httpError(404, "Numero fuera de rango");
    if (t.status === "RESERVED" && t.reservedUntil && t.reservedUntil < Date.now()) {
      // reserva expirada: liberar antes de evaluar
      releaseTicket(t);
    }
    if (t.status !== "FREE") throw httpError(409, "Numero no disponible");

    const id = crypto.randomUUID();
    const reference = `RAFFLE-${slug}-NUM-${number}-${id}`;
    t.status = "RESERVED";
    t.reservedUntil = Date.now() + reserveMs;
    t.purchaseId = id;

    const purchase = {
      id, slug, number, method,
      status: "PENDING",
      reference,
      amountCents: getRaffle(slug).priceCents,
      buyerPublic: pseudonym(buyer.firstName, buyer.lastName),
      // datos privados: jamas en la salida publica
      private: {
        phone: buyer.phone || null,
        email: buyer.email || null,
        document: buyer.document || null,
      },
      receiptUrl: null,       // comprobante manual (almacenamiento privado)
      wompiTransactionId: null,
      purchasedAt: new Date().toISOString(),
      verifiedAt: null,
      approvedBy: null,
      note: null,
    };
    purchases.set(id, purchase);
    byReference.set(reference, id);
    return purchase;
  }

  function releaseTicket(t) {
    t.status = "FREE";
    t.reservedUntil = null;
    t.purchaseId = null;
  }

  function getPurchase(purchaseId) {
    const p = purchases.get(purchaseId);
    if (!p) throw httpError(404, "Compra no encontrada");
    return p;
  }

  function attachReceipt(purchaseId, receiptUrl) {
    const p = purchases.get(purchaseId);
    if (!p) throw httpError(404, "Compra no encontrada");
    p.receiptUrl = receiptUrl; // privado
    return p;
  }

  // Aprueba (equivalente a APPROVED de Wompi): numero -> SOLD, fija verifiedAt.
  function approve(purchaseId, { approvedBy = "admin" } = {}) {
    const p = purchases.get(purchaseId);
    if (!p) throw httpError(404, "Compra no encontrada");
    return markSold(p, { approvedBy });
  }

  function reject(purchaseId, { reason = "" } = {}) {
    const p = purchases.get(purchaseId);
    if (!p) throw httpError(404, "Compra no encontrada");
    p.status = "REJECTED";
    p.note = reason;
    const t = tickets.get(key(p.slug, p.number));
    if (t && t.purchaseId === p.id) releaseTicket(t);
    return p;
  }

  function markSold(p, { approvedBy = "wompi", wompiTransactionId = null } = {}) {
    if (p.status === "APPROVED") return p; // idempotente
    p.status = "APPROVED";
    p.verifiedAt = new Date().toISOString();
    p.approvedBy = approvedBy;
    if (wompiTransactionId) p.wompiTransactionId = wompiTransactionId;
    const t = tickets.get(key(p.slug, p.number));
    if (t) { t.status = "SOLD"; t.reservedUntil = null; }
    return p;
  }

  function findByReference(reference) {
    const id = byReference.get(reference);
    return id ? purchases.get(id) : null;
  }

  // --- Idempotencia de webhook ---
  function alreadyProcessed(txId) { return processedTx.has(txId); }
  function markProcessed(txId) { if (txId) processedTx.add(txId); }

  // --- Declaracion de ganador (valida que el numero este SOLD) ---
  function declareWinner(slug, number, mechanism = "ADMIN_INPUT") {
    const raffle = getRaffle(slug);
    // RANDOM_FROM_SOLD: el backend elige aleatoriamente entre los vendidos.
    if (mechanism === "RANDOM_FROM_SOLD" && (number === undefined || number === null)) {
      const sold = soldPurchases(slug);
      if (!sold.length) throw httpError(422, "No hay numeros vendidos para sortear");
      number = sold[crypto.randomInt(sold.length)].number;
    }
    const t = tickets.get(key(slug, number));
    if (!t || t.status !== "SOLD") {
      throw httpError(422, "El numero declarado no esta vendido (SOLD)");
    }
    const p = purchases.get(t.purchaseId);
    raffle.status = "DRAWN";
    raffle.winner = {
      number,
      buyer: p.buyerPublic,
      purchasedAt: p.purchasedAt,
      verifiedAt: p.verifiedAt,
    };
    return {
      raffleSlug: slug,
      drawnAt: new Date().toISOString(),
      winningNumber: number,
      mechanism,
      winner: raffle.winner,
      status: "VALID",
    };
  }

  function soldPurchases(slug) {
    return [...purchases.values()].filter((p) => p.slug === slug && p.status === "APPROVED");
  }

  // Lista de rifas con contadores (para el panel del administrador).
  function listRaffles() {
    return [...raffles.values()].map((r) => {
      const total = r.numberRange.max - r.numberRange.min + 1;
      return {
        slug: r.slug,
        title: r.title,
        status: r.status,
        sold: soldPurchases(r.slug).length,
        total,
        priceCents: r.priceCents,
        numberRange: r.numberRange,
        winner: r.winner,
      };
    });
  }

  // Compras para la vista de administracion (incluye datos de contacto y
  // comprobante: rol admin/operador segun la Guia). Nunca se publica al exterior.
  function adminPurchases(slug, statusFilter) {
    return [...purchases.values()]
      .filter((p) => p.slug === slug && (!statusFilter || p.status === statusFilter))
      .sort((a, b) => new Date(a.purchasedAt) - new Date(b.purchasedAt))
      .map((p) => ({
        id: p.id,
        number: p.number,
        buyer: p.buyerPublic,
        method: p.method,
        status: p.status,
        purchasedAt: p.purchasedAt,
        verifiedAt: p.verifiedAt,
        receiptUrl: p.receiptUrl,
        contact: p.private,
      }));
  }

  // ------------------------------------------------------------------
  // SALIDA PUBLICA (privacy-safe). Solo estos campos salen al repo/web.
  // ------------------------------------------------------------------
  function publicRaffle(slug) {
    const r = getRaffle(slug);
    return {
      slug: r.slug,
      title: r.title,
      description: r.description,
      prize: r.prize,
      priceCents: r.priceCents,
      currency: r.currency,
      numberRange: r.numberRange,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      minSoldToDraw: r.minSoldToDraw,
      status: r.status,
      winner: r.winner,
    };
  }

  function publicNumbers(slug) {
    getRaffle(slug);
    const sold = soldPurchases(slug)
      .sort((a, b) => a.number - b.number)
      .map((p) => ({
        number: p.number,
        buyer: p.buyerPublic,       // "Juan S." — sin apellido completo
        purchasedAt: p.purchasedAt,
        verifiedAt: p.verifiedAt,
      }));
    return { version: new Date().toISOString(), sold };
  }

  function expireReservations() {
    const now = Date.now();
    let freed = 0;
    for (const t of tickets.values()) {
      if (t.status === "RESERVED" && t.reservedUntil && t.reservedUntil < now) {
        const p = t.purchaseId && purchases.get(t.purchaseId);
        if (p && p.status === "PENDING") p.status = "REJECTED", (p.note = "Reserva expirada");
        releaseTicket(t);
        freed++;
      }
    }
    return freed;
  }

  // ------------------------------------------------------------------
  // Autenticacion / autorizacion (equivalente en memoria)
  // ------------------------------------------------------------------
  const admins = new Map();        // id -> user
  const adminsByEmail = new Map(); // email -> id
  const refreshTokens = new Map(); // tokenHash -> { userId, expiresAt, revokedAt }
  const auditEntries = [];

  const countAdmins = () => admins.size;

  function createAdmin({ email, passwordHash, role = "ADMIN" }) {
    const mail = String(email).toLowerCase().trim();
    if (adminsByEmail.has(mail)) throw httpError(409, "Ya existe un administrador con ese correo");
    const id = crypto.randomUUID();
    const user = { id, email: mail, passwordHash, totpSecret: null, totpEnabled: false, role, lastLoginAt: null };
    admins.set(id, user);
    adminsByEmail.set(mail, id);
    return user;
  }

  const getAdminByEmail = (email) => admins.get(adminsByEmail.get(String(email || "").toLowerCase().trim())) || null;
  const getAdminById = (id) => admins.get(id) || null;

  function setAdminTotp(id, secret, enabled) {
    const u = admins.get(id);
    if (!u) throw httpError(404, "Administrador no encontrado");
    u.totpSecret = secret;
    u.totpEnabled = enabled;
    return u;
  }

  function touchAdminLogin(id) {
    const u = admins.get(id);
    if (u) u.lastLoginAt = new Date().toISOString();
  }

  function saveRefreshToken(tokenHash, userId, expiresAt) {
    refreshTokens.set(tokenHash, { userId, expiresAt: new Date(expiresAt), revokedAt: null });
  }

  function getRefreshToken(tokenHash) {
    const t = refreshTokens.get(tokenHash);
    if (!t || t.revokedAt || t.expiresAt < new Date()) return null;
    return { tokenHash, userId: t.userId };
  }

  function revokeRefreshToken(tokenHash) {
    const t = refreshTokens.get(tokenHash);
    if (t) t.revokedAt = new Date();
  }

  function audit(entry) {
    auditEntries.push({ ...entry, createdAt: new Date().toISOString() });
  }

  // --- Rate limiting (equivalente en memoria; en serverless usar el de PostgreSQL) ---
  const rateBuckets = new Map();

  function hitRateLimit(bucket, expiresAt) {
    const b = rateBuckets.get(bucket);
    if (!b || b.expiresAt <= new Date()) {
      rateBuckets.set(bucket, { hits: 1, expiresAt: new Date(expiresAt) });
      return 1;
    }
    b.hits += 1;
    return b.hits;
  }

  function cleanupRateLimits() {
    const now = new Date();
    let n = 0;
    for (const [k, v] of rateBuckets) if (v.expiresAt < now) { rateBuckets.delete(k); n++; }
    return n;
  }

  return {
    kind: "memory",
    createRaffle, getRaffle, reserve, getPurchase, attachReceipt, approve, reject, markSold,
    findByReference, alreadyProcessed, markProcessed, declareWinner,
    publicRaffle, publicNumbers, expireReservations, soldPurchases,
    listRaffles, adminPurchases,
    countAdmins, createAdmin, getAdminByEmail, getAdminById, setAdminTotp, touchAdminLogin,
    saveRefreshToken, getRefreshToken, revokeRefreshToken, audit,
    hitRateLimit, cleanupRateLimits,
    close: async () => {},
    _raffles: raffles, _tickets: tickets, _purchases: purchases, _audit: auditEntries,
  };
}
