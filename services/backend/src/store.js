// Modelo de datos en memoria (reemplazable por PostgreSQL en produccion).
// Regla de oro: los datos privados (telefono, correo, documento, comprobante)
// viven SOLO en el objeto `private` de cada compra y NUNCA salen al estado publico.

import crypto from "node:crypto";
import { httpError } from "./http-error.js";
import {
  normalizeMedia, normalizePrizeItems, normalizeTheme, prizeTotalCents,
} from "./raffle-media.js";
import {
  normalizePaymentMethods, validarComprobante, assertMetodoPermitido, assertFechas,
} from "./payments.js";

// Se re-exporta para no romper a quien ya lo importaba desde aqui.
export { httpError };

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

/**
 * Por que un numero no esta disponible, en palabras del comprador.
 *
 * Los tres casos son muy distintos para quien esta comprando: uno es definitivo,
 * otro se resuelve en minutos y otro depende de que un admin revise un pago. No
 * revela QUIEN lo tiene: solo el estado del numero.
 */
export function motivoNoDisponible(ticket, ocupante) {
  if (ticket.status === "SOLD") return "Ese número ya está vendido. Elige otro.";
  if (ocupante?.receiptAt || ocupante?.receipt_at) {
    return "Ese número está pendiente de confirmación: alguien ya envió el pago y un administrador lo está verificando. Elige otro.";
  }
  return "Ese número está apartado por otra persona ahora mismo. Si no completa el pago volverá a quedar libre; mientras tanto, elige otro.";
}

export function createStore({ reserveMinutes = 15, manualReserveMinutes } = {}) {
  const reserveMs = reserveMinutes * 60 * 1000;
  // El pago manual es un tramite humano (abrir Nequi, pagar, capturar, subir):
  // por defecto 4x la ventana de la pasarela. Si reserveMinutes es 0 (pruebas),
  // manual tambien es 0 y la reserva nace vencida a proposito.
  const manualReserveMs = (manualReserveMinutes ?? reserveMinutes * 4) * 60 * 1000;
  const raffles = new Map(); // slug -> raffle
  const tickets = new Map(); // `${slug}#${n}` -> ticket
  const purchases = new Map(); // id -> purchase
  const byReference = new Map(); // reference -> purchaseId
  const processedTx = new Set(); // idempotencia webhook (wompi_transaction_id)

  const key = (slug, n) => `${slug}#${n}`;

  function createRaffle(cfg) {
    if (raffles.has(cfg.slug)) return raffles.get(cfg.slug);
    assertFechas(cfg.endsAt, cfg.drawAt);
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
      // Fecha del SORTEO: distinta del cierre de ventas. Se juega despues.
      drawAt: cfg.drawAt || null,
      minSoldToDraw: cfg.minSoldToDraw ?? 0,
      status: cfg.status || "ACTIVE",
      winner: null,
      // Medios de pago: NO se publican (ver payments.js). Los sirve la API.
      paymentMethods: normalizePaymentMethods(cfg.paymentMethods),
      gatewayEnabled: cfg.gatewayEnabled !== false,
      manualEnabled: cfg.manualEnabled !== false,
      // Premio mostrable. El total NO se guarda: se calcula al leer.
      media: normalizeMedia(cfg.media),
      prizeItems: normalizePrizeItems(cfg.prizeItems),
      theme: normalizeTheme(cfg.theme),
      publishedAt: null,
      repoFullName: null,
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
    const raffle = getRaffle(slug);
    // Se valida en el servidor, no solo escondiendo el boton en la app.
    assertMetodoPermitido(raffle, method);
    const t = tickets.get(key(slug, number));
    if (!t) throw httpError(404, "Numero fuera de rango");
    if (t.status === "RESERVED" && t.reservedUntil && t.reservedUntil < Date.now()) {
      // Reserva vencida: liberar antes de evaluar. PERO nunca si ya mandaron el
      // comprobante: ese numero esta pagado y esperando revision, y soltarlo aqui
      // se lo entregaria al siguiente que lo pida. La misma regla que en
      // expireReservations; este es el otro camino por el que se libera un ticket.
      const previa = t.purchaseId && purchases.get(t.purchaseId);
      if (!previa?.receiptAt) releaseTicket(t);
    }
    if (t.status !== "FREE") {
      // El motivo, no solo el rechazo: "no disponible" a secas deja al comprador
      // sin saber si esperar (una reserva se cae en minutos) o buscar otro.
      const ocupante = t.purchaseId && purchases.get(t.purchaseId);
      throw httpError(409, motivoNoDisponible(t, ocupante));
    }

    const id = crypto.randomUUID();
    const reference = `RAFFLE-${slug}-NUM-${number}-${id}`;
    t.status = "RESERVED";
    // El pago manual necesita mas tiempo: hay que abrir Nequi, pagar, tomar el
    // pantallazo y volver. Con la ventana de la pasarela (inmediata) se le
    // caeria el numero a medio pagar.
    t.reservedUntil = Date.now() + (method === "MANUAL" ? manualReserveMs : reserveMs);
    t.purchaseId = id;

    const purchase = {
      id, slug, number, method,
      status: "PENDING",
      reference,
      amountCents: raffle.priceCents,
      buyerPublic: pseudonym(buyer.firstName, buyer.lastName),
      // datos privados: jamas en la salida publica
      private: {
        phone: buyer.phone || null,
        email: buyer.email || null,
        document: buyer.document || null,
      },
      // Comprobante manual: bytes PRIVADOS. Nunca sale al estado publico ni al
      // repo de la rifa; solo lo ve un administrador autenticado.
      receipt: null,          // { bytes, mime }
      receiptAt: null,
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

  /**
   * Adjunta el comprobante del pago manual (bytes PRIVADOS).
   *
   * A partir de aqui el numero queda retenido hasta que un humano decida:
   * expireReservations respeta toda compra con `receiptAt`.
   */
  function attachReceipt(purchaseId, { bytes, mime } = {}) {
    const p = purchases.get(purchaseId);
    if (!p) throw httpError(404, "Compra no encontrada");
    if (p.status !== "PENDING") {
      throw httpError(409, `La compra ya esta ${p.status}: no admite comprobante`);
    }
    const real = validarComprobante(bytes);
    p.receipt = { bytes, mime: real || mime };
    p.receiptAt = new Date().toISOString();
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

  /**
   * Anula una venta ya aprobada: libera el numero y marca la compra como VOID.
   * Necesario para errores y devoluciones (la Guia contempla el caso pero no
   * existia forma de hacerlo: solo se podia aprobar o rechazar antes de cobrar).
   */
  function voidPurchase(purchaseId, { reason = "" } = {}) {
    const p = purchases.get(purchaseId);
    if (!p) throw httpError(404, "Compra no encontrada");
    if (p.status !== "APPROVED") {
      throw httpError(409, "Solo se puede anular una venta aprobada");
    }
    const raffle = raffles.get(p.slug);
    // Anular al ganador dejaria draw.json apuntando a un numero sin vender.
    if (raffle?.winner && raffle.winner.number === p.number) {
      throw httpError(409, "No se puede anular el numero ganador de un sorteo ya declarado");
    }
    p.status = "VOID";
    p.note = reason;
    const t = tickets.get(key(p.slug, p.number));
    if (t) releaseTicket(t);
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
        // Estado de publicacion: sin esto el admin no puede saber si una rifa ya
        // esta en GitHub y muestra "Publicar" para siempre.
        publishedAt: r.publishedAt || null,
        repoFullName: r.repoFullName || null,
        prizeTotalCents: prizeTotalCents(r.prizeItems),
        cover: r.media?.cover || null,
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
        // Solo SI hay comprobante y cuando llego. Los bytes se piden aparte
        // (GET /api/purchases/:id/receipt): meter la imagen en el listado
        // cargaria megas por cada fila que el admin quizas ni abre.
        hasReceipt: Boolean(p.receiptAt),
        receiptAt: p.receiptAt || null,
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
      drawAt: r.drawAt || null,
      minSoldToDraw: r.minSoldToDraw,
      status: r.status,
      winner: r.winner,
      media: r.media || {},
      prizeItems: r.prizeItems || [],
      // Calculado, nunca almacenado: no puede contradecir al desglose.
      prizeTotalCents: prizeTotalCents(r.prizeItems),
      theme: r.theme || {},
      // OJO: paymentMethods NO va aqui. Esta forma se commitea a un repo publico
      // e inmutable; un numero de cuenta ahi queda para siempre. Se sirven por
      // la API (paymentInfo), que es lo que necesita quien va a comprar.
    };
  }

  /**
   * Datos para pagar. Publico (quien compra necesita verlos) pero servido por la
   * API y NO publicado al repo, a diferencia del resto del estado.
   */
  /**
   * Numeros apartados ahora mismo (reserva viva o esperando verificacion).
   *
   * SOLO numeros: ni nombre, ni telefono, ni cuando. Que un numero este tomado
   * es informacion que el comprador necesita; quien lo tomo, no.
   */
  function heldNumbers(slug) {
    getRaffle(slug);
    const ahora = Date.now();
    const held = [];
    for (const t of tickets.values()) {
      if (t.slug !== slug || t.status !== "RESERVED") continue;
      const p = t.purchaseId && purchases.get(t.purchaseId);
      // Vencida y sin comprobante = va a caerse en el proximo cron: se muestra
      // libre para no espantar a un comprador por un numero que ya es suyo.
      const viva = !t.reservedUntil || t.reservedUntil >= ahora;
      if (viva || p?.receiptAt) held.push(t.number);
    }
    return { held: held.sort((a, b) => a - b) };
  }

  /** Bytes del comprobante. Solo para roles autorizados: es dato privado. */
  function getReceipt(purchaseId) {
    const p = purchases.get(purchaseId);
    if (!p) throw httpError(404, "Compra no encontrada");
    if (!p.receipt) throw httpError(404, "Esta compra no tiene comprobante");
    return p.receipt;
  }

  function paymentInfo(slug) {
    const r = getRaffle(slug);
    return {
      slug: r.slug,
      gatewayEnabled: r.gatewayEnabled !== false,
      manualEnabled: r.manualEnabled !== false,
      paymentMethods: r.paymentMethods || [],
    };
  }

  /**
   * Edita los campos "de vitrina" de una rifa ya creada.
   *
   * Deliberadamente NO deja tocar `numberRange`: los tickets ya existen y hay
   * numeros vendidos. Cambiar el rango en caliente dejaria compras apuntando a
   * numeros fuera de rango.
   */
  function updateRaffle(slug, patch) {
    const r = getRaffle(slug);
    // Las fechas se validan como PAR: mandar solo una debe cotejarse contra la
    // que ya esta guardada, o se podria dejar el sorteo antes del cierre.
    const endsAt = patch.endsAt !== undefined ? patch.endsAt : r.endsAt;
    const drawAt = patch.drawAt !== undefined ? patch.drawAt : r.drawAt;
    assertFechas(endsAt, drawAt);

    if (patch.title !== undefined) r.title = String(patch.title).trim() || r.title;
    if (patch.description !== undefined) r.description = String(patch.description).trim();
    if (patch.prize !== undefined) r.prize = String(patch.prize).trim() || r.prize;
    if (patch.media !== undefined) r.media = normalizeMedia(patch.media);
    if (patch.prizeItems !== undefined) r.prizeItems = normalizePrizeItems(patch.prizeItems);
    if (patch.theme !== undefined) r.theme = normalizeTheme(patch.theme);
    if (patch.endsAt !== undefined) r.endsAt = patch.endsAt;
    // Posponer el sorteo es una operacion legitima: si no se vende el minimo,
    // la Guia manda aplazar en vez de sortear.
    if (patch.drawAt !== undefined) r.drawAt = patch.drawAt || null;
    if (patch.minSoldToDraw !== undefined) r.minSoldToDraw = Number(patch.minSoldToDraw) || 0;
    if (patch.paymentMethods !== undefined) r.paymentMethods = normalizePaymentMethods(patch.paymentMethods);
    if (patch.gatewayEnabled !== undefined) r.gatewayEnabled = Boolean(patch.gatewayEnabled);
    if (patch.manualEnabled !== undefined) r.manualEnabled = Boolean(patch.manualEnabled);
    return publicRaffle(slug);
  }

  // La escribe el publicador tras un push exitoso: es lo que permite al admin
  // distinguir "nunca publicada" de "publicada" sin adivinar.
  function markPublished(slug, repoFullName) {
    const r = getRaffle(slug);
    r.publishedAt = new Date().toISOString();
    r.repoFullName = repoFullName || r.repoFullName;
    return r;
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

  /**
   * Libera las reservas vencidas.
   *
   * NUNCA toca una compra con comprobante adjunto, por vencida que este.
   * Sin esa guarda, el comprador paga por Nequi, sube el pantallazo, y el cron
   * le rechaza la compra y libera su numero mientras espera al administrador:
   * dinero real perdido y un numero que se puede vender dos veces. Una compra
   * con comprobante solo sale de PENDING cuando un humano decide.
   */
  function expireReservations() {
    const now = Date.now();
    let freed = 0;
    for (const t of tickets.values()) {
      if (t.status === "RESERVED" && t.reservedUntil && t.reservedUntil < now) {
        const p = t.purchaseId && purchases.get(t.purchaseId);
        if (p && p.receiptAt) continue; // esperando revision humana: se respeta
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
    createRaffle, getRaffle, updateRaffle, markPublished,
    reserve, getPurchase, attachReceipt, getReceipt, approve, reject, voidPurchase, markSold,
    findByReference, alreadyProcessed, markProcessed, declareWinner,
    publicRaffle, paymentInfo, publicNumbers, heldNumbers, expireReservations, soldPurchases,
    listRaffles, adminPurchases,
    countAdmins, createAdmin, getAdminByEmail, getAdminById, setAdminTotp, touchAdminLogin,
    saveRefreshToken, getRefreshToken, revokeRefreshToken, audit,
    hitRateLimit, cleanupRateLimits,
    close: async () => {},
    _raffles: raffles, _tickets: tickets, _purchases: purchases, _audit: auditEntries,
  };
}
