// Store persistente en PostgreSQL. Misma interfaz que el store en memoria
// (metodos async). Se activa cuando DATABASE_URL esta definida.
//
// Atomicidad de reserva (Guia 6.4): el UPDATE condicional sobre `tickets`
// (WHERE status='FREE' OR reserva expirada) toma el row lock; una transaccion
// concurrente se bloquea y luego ve RESERVED -> rowCount 0 -> 409.

import fs from "node:fs";
import crypto from "node:crypto";
import { httpError, pseudonym, motivoNoDisponible } from "./store.js";
import {
  normalizeMedia, normalizePrizeItems, normalizeTheme, prizeTotalCents,
} from "./raffle-media.js";
import {
  normalizePaymentMethods, validarComprobante, assertMetodoPermitido, assertFechas,
} from "./payments.js";
import { normalizeOrganizer } from "./legal.js";

// Las migraciones viven junto al servicio para que viajen con el despliegue.
const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * Columnas de `purchases` SIN la imagen del comprobante.
 *
 * `SELECT *` traeria receipt_image (un BYTEA de cientos de KB) en cada consulta.
 * soldPurchases puede devolver 1000 filas: serian cientos de megas cruzando la
 * red para acabar descartados. La imagen se pide explicitamente con getReceipt.
 */
const COLS_PURCHASE = `id, slug, number, method, status, reference, amount_cents,
  buyer_public, private, wompi_transaction_id, purchased_at, verified_at,
  approved_by, note, receipt_at`;

// Lista blanca explicita: esta forma ES la que se publica a GitHub. Un `SELECT *`
// mapeado a ciegas convertiria cualquier columna futura en dato publico.
function mapRaffle(r) {
  const prizeItems = r.prize_items || [];
  return {
    slug: r.slug,
    title: r.title,
    description: r.description || "",
    prize: r.prize,
    priceCents: Number(r.price_cents),
    currency: r.currency,
    numberRange: { min: r.number_min, max: r.number_max },
    startsAt: iso(r.starts_at),
    endsAt: iso(r.ends_at),
    // Fecha del SORTEO: distinta del cierre de ventas.
    drawAt: iso(r.draw_at),
    minSoldToDraw: r.min_sold_to_draw,
    status: r.status,
    winner: r.winner || null,
    media: r.media || {},
    prizeItems,
    // Calculado al leer, nunca almacenado: no puede contradecir al desglose.
    prizeTotalCents: prizeTotalCents(prizeItems),
    theme: r.theme || {},
    // Responsable: SI se publica (transparencia legal); el organizador se
    // identifica a proposito. Distinto de payment_methods, que es privado.
    organizer: r.organizer || {},
    // OJO: payment_methods NO va aqui. Esta forma se commitea a un repo publico e
    // inmutable; un numero de cuenta ahi queda para siempre. Los sirve paymentInfo.
  };
}

function mapPurchase(p) {
  return {
    id: p.id,
    slug: p.slug,
    number: p.number,
    method: p.method,
    status: p.status,
    reference: p.reference,
    amountCents: Number(p.amount_cents),
    buyerPublic: p.buyer_public,
    private: p.private || {},
    // Solo SI hay comprobante y cuando llego. Los BYTES nunca entran en esta
    // forma: se piden aparte (getReceipt) y solo con rol autorizado.
    hasReceipt: Boolean(p.receipt_at),
    receiptAt: iso(p.receipt_at),
    wompiTransactionId: p.wompi_transaction_id,
    purchasedAt: iso(p.purchased_at),
    verifiedAt: iso(p.verified_at),
    approvedBy: p.approved_by,
    note: p.note,
  };
}

export async function createPostgresStore(
  databaseUrl,
  { reserveMinutes = 15, manualReserveMinutes = reserveMinutes * 4 } = {},
) {
  const { default: pg } = await import("pg");

  // Proveedores gestionados (Neon, Vercel Postgres) exigen TLS; en local no.
  const isLocal = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(databaseUrl);
  // En serverless conviene un pool pequeño: hay muchos contenedores concurrentes.
  const defaultMax = isLocal ? 10 : 3;

  // Quitamos `sslmode` de la cadena y configuramos el TLS explicitamente aqui.
  // Motivo: pg avisa de que en v9 los modos 'require'/'prefer' pasaran a la
  // semantica de libpq, que es MAS DEBIL (hoy equivalen a verify-full). Al fijar
  // `ssl` a mano, la verificacion no depende de ese cambio futuro (y desaparece
  // el aviso que ensuciaba los logs en cada arranque en frio).
  const conn = databaseUrl.replace(/([?&])sslmode=[^&]*(&|$)/, (_m, p1, p2) => (p2 === "&" ? p1 : ""));

  const pool = new pg.Pool({
    connectionString: conn,
    max: Number(process.env.PG_POOL_MAX || defaultMax),
    ssl: isLocal ? false : { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== "true" },
  });

  // Migraciones idempotentes al arrancar, en orden alfabetico (001_, 002_, ...).
  //
  // Se toma un advisory lock de sesion mientras corren: dos conexiones
  // ejecutando el DDL a la vez (varios contenedores en arranque en frio contra
  // Neon, o varios archivos de test) chocan en el catalogo del sistema y lanzan
  // "duplicate key value ... pg_type_typname_nsp_index". El lock serializa esos
  // arranques; el segundo espera, encuentra todo ya creado (IF NOT EXISTS) y
  // sigue. Se usa UNA conexion para lock+migraciones (el lock es por sesion).
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  if (!files.length) throw new Error(`Sin migraciones en ${MIGRATIONS_DIR.pathname}`);
  const migConn = await pool.connect();
  try {
    await migConn.query("SELECT pg_advisory_lock(550716)");
    for (const f of files) {
      await migConn.query(fs.readFileSync(new URL(f, MIGRATIONS_DIR), "utf8"));
    }
  } finally {
    await migConn.query("SELECT pg_advisory_unlock(550716)").catch(() => {});
    migConn.release();
  }

  const q = (text, params) => pool.query(text, params);

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function createRaffle(cfg) {
    // Se valida ANTES de abrir la transaccion: si el premio viene mal, no tiene
    // sentido haber creado 1000 tickets para luego revertirlos.
    assertFechas(cfg.endsAt, cfg.drawAt);
    const media = normalizeMedia(cfg.media);
    const prizeItems = normalizePrizeItems(cfg.prizeItems);
    const theme = normalizeTheme(cfg.theme);
    const pagos = normalizePaymentMethods(cfg.paymentMethods);
    const organizer = normalizeOrganizer(cfg.organizer);
    await tx(async (c) => {
      await c.query(
        `INSERT INTO raffles (slug,title,description,prize,price_cents,currency,number_min,number_max,starts_at,ends_at,draw_at,min_sold_to_draw,status,media,prize_items,theme,payment_methods,gateway_enabled,manual_enabled,organizer)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT (slug) DO NOTHING`,
        [cfg.slug, cfg.title, cfg.description || "", cfg.prize, cfg.priceCents, cfg.currency || "COP",
         cfg.numberRange.min, cfg.numberRange.max, cfg.startsAt, cfg.endsAt, cfg.drawAt || null,
         cfg.minSoldToDraw ?? 0, cfg.status || "ACTIVE",
         JSON.stringify(media), JSON.stringify(prizeItems), JSON.stringify(theme),
         JSON.stringify(pagos), cfg.gatewayEnabled !== false, cfg.manualEnabled !== false,
         JSON.stringify(organizer)]
      );
      await c.query(
        `INSERT INTO tickets (slug, number) SELECT $1, g FROM generate_series($2::int, $3::int) g
         ON CONFLICT (slug, number) DO NOTHING`,
        [cfg.slug, cfg.numberRange.min, cfg.numberRange.max]
      );
    });
    return getRaffle(cfg.slug);
  }

  async function getRaffle(slug) {
    const { rows } = await q(`SELECT * FROM raffles WHERE slug=$1`, [slug]);
    if (!rows.length) throw httpError(404, "Rifa no encontrada");
    return mapRaffle(rows[0]);
  }

  /**
   * Edita los campos "de vitrina". NO toca `numberRange`: los tickets ya existen
   * y puede haber numeros vendidos; cambiar el rango en caliente dejaria compras
   * apuntando fuera de rango.
   *
   * COALESCE con parametros nulos = "no lo mandaste, no lo toco". Asi el admin
   * puede mandar solo `prizeItems` sin borrar el resto sin querer.
   */
  async function updateRaffle(slug, patch) {
    const actual = await getRaffle(slug); // 404 si no existe
    // Las fechas se validan como PAR contra lo ya guardado: mandar solo una no
    // puede dejar el sorteo antes del cierre.
    assertFechas(
      patch.endsAt !== undefined ? patch.endsAt : actual.endsAt,
      patch.drawAt !== undefined ? patch.drawAt : actual.drawAt,
    );
    const media = patch.media === undefined ? null : JSON.stringify(normalizeMedia(patch.media));
    const items = patch.prizeItems === undefined ? null : JSON.stringify(normalizePrizeItems(patch.prizeItems));
    const theme = patch.theme === undefined ? null : JSON.stringify(normalizeTheme(patch.theme));
    const pagos = patch.paymentMethods === undefined ? null : JSON.stringify(normalizePaymentMethods(patch.paymentMethods));
    const organizer = patch.organizer === undefined ? null : JSON.stringify(normalizeOrganizer(patch.organizer));
    await q(
      `UPDATE raffles SET
         title           = COALESCE($2, title),
         description     = COALESCE($3, description),
         prize           = COALESCE($4, prize),
         media           = COALESCE($5::jsonb, media),
         prize_items     = COALESCE($6::jsonb, prize_items),
         theme           = COALESCE($7::jsonb, theme),
         ends_at         = COALESCE($8::timestamptz, ends_at),
         draw_at         = CASE WHEN $9::boolean THEN $10::timestamptz ELSE draw_at END,
         min_sold_to_draw= COALESCE($11::int, min_sold_to_draw),
         payment_methods = COALESCE($12::jsonb, payment_methods),
         gateway_enabled = COALESCE($13::boolean, gateway_enabled),
         manual_enabled  = COALESCE($14::boolean, manual_enabled),
         organizer       = COALESCE($15::jsonb, organizer)
       WHERE slug=$1`,
      [
        slug,
        patch.title === undefined ? null : String(patch.title).trim() || null,
        patch.description === undefined ? null : String(patch.description).trim(),
        patch.prize === undefined ? null : String(patch.prize).trim() || null,
        media, items, theme,
        patch.endsAt === undefined ? null : patch.endsAt,
        // draw_at necesita CASE y no COALESCE: null es un valor legitimo (quitar
        // la fecha), y COALESCE no distingue "mandaste null" de "no lo mandaste".
        patch.drawAt !== undefined,
        patch.drawAt || null,
        patch.minSoldToDraw === undefined ? null : Number(patch.minSoldToDraw) || 0,
        pagos,
        patch.gatewayEnabled === undefined ? null : Boolean(patch.gatewayEnabled),
        patch.manualEnabled === undefined ? null : Boolean(patch.manualEnabled),
        organizer,
      ]
    );
    return getRaffle(slug);
  }

  /**
   * Datos para pagar. Publico (quien compra los necesita) pero servido por la
   * API y NO publicado al repo: el historial de git es inmutable.
   */
  async function paymentInfo(slug) {
    const { rows } = await q(
      `SELECT slug, payment_methods, gateway_enabled, manual_enabled FROM raffles WHERE slug=$1`,
      [slug]
    );
    if (!rows.length) throw httpError(404, "Rifa no encontrada");
    const r = rows[0];
    return {
      slug: r.slug,
      gatewayEnabled: r.gateway_enabled,
      manualEnabled: r.manual_enabled,
      paymentMethods: r.payment_methods || [],
    };
  }

  // La escribe el publicador tras un push exitoso: es lo unico que permite al
  // admin distinguir "nunca publicada" de "publicada".
  async function markPublished(slug, repoFullName) {
    await q(
      `UPDATE raffles SET published_at = now(), repo_full_name = COALESCE($2, repo_full_name)
        WHERE slug=$1`,
      [slug, repoFullName || null]
    );
  }

  async function reserve(slug, number, buyer, method = "MANUAL") {
    const raffle = await getRaffle(slug);
    // Se valida en el servidor, no solo escondiendo el boton en la app: apagar
    // la pasarela debe cerrarla de verdad, aunque llamen a la API a mano.
    const info = await paymentInfo(slug);
    assertMetodoPermitido(info, method);
    if (number < raffle.numberRange.min || number > raffle.numberRange.max) {
      throw httpError(404, "Numero fuera de rango");
    }
    const id = crypto.randomUUID();
    const reference = `RAFFLE-${slug}-NUM-${number}-${id}`;
    // El pago manual necesita mas tiempo: abrir Nequi, pagar, capturar y volver.
    const minutos = method === "MANUAL" ? manualReserveMinutes : reserveMinutes;
    const until = new Date(Date.now() + minutos * 60_000);

    return tx(async (c) => {
      // 1) Reclamo atomico del numero (libre o con reserva vencida).
      //
      // La reserva vencida NO se reclama si la compra anterior ya mando su
      // comprobante: ese numero esta pagado y esperando a un humano, y darselo
      // al siguiente que lo pida le robaria la compra a quien ya puso la plata.
      // Es la misma regla que en expireReservations; este es el otro camino por
      // el que un ticket cambia de manos.
      const claim = await c.query(
        `UPDATE tickets SET status='RESERVED', reserved_until=$3
           WHERE slug=$1 AND number=$2
             AND (status='FREE' OR (
                   status='RESERVED' AND reserved_until < now()
                   AND (purchase_id IS NULL OR purchase_id IN (
                     SELECT id FROM purchases WHERE receipt_at IS NULL))))
         RETURNING number`,
        [slug, number, until]
      );
      if (claim.rowCount === 0) {
        // El UPDATE solo dice que no toco filas. Se consulta el ticket para
        // decirle al comprador POR QUE: vendido, apartado o esperando que un
        // admin verifique un pago son tres situaciones muy distintas para el.
        const { rows } = await c.query(
          `SELECT t.status, p.receipt_at
             FROM tickets t LEFT JOIN purchases p ON p.id = t.purchase_id
            WHERE t.slug=$1 AND t.number=$2`,
          [slug, number]
        );
        throw httpError(409, motivoNoDisponible(rows[0] || { status: "RESERVED" }, rows[0]));
      }

      // 2) Crear la compra.
      const { rows } = await c.query(
        `INSERT INTO purchases (id,slug,number,method,status,reference,amount_cents,buyer_public,private)
         VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7,$8) RETURNING *`,
        [id, slug, number, method, reference, raffle.priceCents,
         pseudonym(buyer.firstName, buyer.lastName),
         JSON.stringify({ phone: buyer.phone || null, email: buyer.email || null, document: buyer.document || null })]
      );

      // 3) Enlazar ticket -> compra.
      await c.query(`UPDATE tickets SET purchase_id=$3 WHERE slug=$1 AND number=$2`, [slug, number, id]);
      return mapPurchase(rows[0]);
    });
  }

  async function getPurchase(id) {
    const { rows } = await q(`SELECT ${COLS_PURCHASE} FROM purchases WHERE id=$1`, [id]);
    if (!rows.length) throw httpError(404, "Compra no encontrada");
    return mapPurchase(rows[0]);
  }

  /**
   * Adjunta el comprobante del pago manual (bytes PRIVADOS, en la base).
   *
   * No va al repo de la rifa como las fotos del premio: un pantallazo de Nequi
   * lleva nombre completo, banco y a veces el saldo. Es privado por naturaleza.
   *
   * A partir de aqui el numero queda retenido hasta que un humano decida:
   * expireReservations y reserve respetan toda compra con `receipt_at`.
   */
  async function attachReceipt(purchaseId, { bytes, mime } = {}) {
    const mimeReal = validarComprobante(bytes);
    const { rows } = await q(
      `UPDATE purchases SET receipt_image=$2, receipt_mime=$3, receipt_at=now()
         WHERE id=$1 AND status='PENDING' RETURNING *`,
      [purchaseId, bytes, mimeReal || mime]
    );
    if (!rows.length) {
      // Distinguir "no existe" de "ya no admite comprobante": el comprador
      // merece saber si llego tarde porque ya se la aprobaron o rechazaron.
      const { rows: existe } = await q(`SELECT status FROM purchases WHERE id=$1`, [purchaseId]);
      if (!existe.length) throw httpError(404, "Compra no encontrada");
      throw httpError(409, `La compra ya esta ${existe[0].status}: no admite comprobante`);
    }
    return mapPurchase(rows[0]);
  }

  /**
   * Numeros apartados ahora mismo (reserva viva o esperando verificacion).
   *
   * SOLO numeros: ni nombre, ni telefono, ni cuando. Que un numero este tomado
   * es informacion que el comprador necesita; quien lo tomo, no.
   *
   * La reserva vencida SIN comprobante se omite: se va a caer en el proximo
   * cron, asi que mostrarla como tomada espantaria a un comprador de un numero
   * que en realidad ya puede pedir.
   */
  async function heldNumbers(slug) {
    await getRaffle(slug);
    const { rows } = await q(
      `SELECT t.number
         FROM tickets t
         LEFT JOIN purchases p ON p.id = t.purchase_id
        WHERE t.slug = $1 AND t.status = 'RESERVED'
          AND (t.reserved_until IS NULL OR t.reserved_until >= now() OR p.receipt_at IS NOT NULL)
        ORDER BY t.number`,
      [slug]
    );
    return { held: rows.map((r) => r.number) };
  }

  /** Bytes del comprobante. Solo para roles autorizados: es dato privado. */
  async function getReceipt(purchaseId) {
    const { rows } = await q(
      `SELECT receipt_image, receipt_mime FROM purchases WHERE id=$1`, [purchaseId]
    );
    if (!rows.length) throw httpError(404, "Compra no encontrada");
    if (!rows[0].receipt_image) throw httpError(404, "Esta compra no tiene comprobante");
    return { bytes: rows[0].receipt_image, mime: rows[0].receipt_mime || "image/jpeg" };
  }

  async function markSold(purchase, { approvedBy = "wompi", wompiTransactionId = null } = {}) {
    return tx(async (c) => {
      const upd = await c.query(
        `UPDATE purchases SET status='APPROVED', verified_at=now(), approved_by=$2,
                wompi_transaction_id=COALESCE($3, wompi_transaction_id)
           WHERE id=$1 AND status <> 'APPROVED' RETURNING *`,
        [purchase.id, approvedBy, wompiTransactionId]
      );
      if (upd.rowCount === 0) {
        const cur = await c.query(`SELECT ${COLS_PURCHASE} FROM purchases WHERE id=$1`, [purchase.id]);
        if (!cur.rows.length) throw httpError(404, "Compra no encontrada");
        return mapPurchase(cur.rows[0]); // ya estaba aprobada -> idempotente
      }
      const p = upd.rows[0];
      await c.query(
        `UPDATE tickets SET status='SOLD', reserved_until=NULL WHERE slug=$1 AND number=$2`,
        [p.slug, p.number]
      );
      return mapPurchase(p);
    });
  }

  async function approve(purchaseId, { approvedBy = "admin" } = {}) {
    const p = await getPurchase(purchaseId);
    return markSold(p, { approvedBy });
  }

  async function reject(purchaseId, { reason = "" } = {}) {
    return tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE purchases SET status='REJECTED', note=$2 WHERE id=$1 RETURNING *`,
        [purchaseId, reason]
      );
      if (!rows.length) throw httpError(404, "Compra no encontrada");
      const p = rows[0];
      await c.query(
        `UPDATE tickets SET status='FREE', reserved_until=NULL, purchase_id=NULL
           WHERE slug=$1 AND number=$2 AND purchase_id=$3`,
        [p.slug, p.number, p.id]
      );
      return mapPurchase(p);
    });
  }

  /**
   * Anula una venta aprobada: libera el numero y marca la compra como VOID.
   * En transaccion: no puede quedar la compra anulada con el numero aun ocupado.
   */
  async function voidPurchase(purchaseId, { reason = "" } = {}) {
    return tx(async (c) => {
      const cur = await c.query(
        `SELECT p.*, r.winner FROM purchases p JOIN raffles r ON r.slug = p.slug WHERE p.id = $1`,
        [purchaseId]
      );
      if (!cur.rows.length) throw httpError(404, "Compra no encontrada");
      const row = cur.rows[0];
      if (row.status !== "APPROVED") throw httpError(409, "Solo se puede anular una venta aprobada");
      // Anular al ganador dejaria draw.json apuntando a un numero sin vender.
      if (row.winner && row.winner.number === row.number) {
        throw httpError(409, "No se puede anular el numero ganador de un sorteo ya declarado");
      }
      const upd = await c.query(
        `UPDATE purchases SET status='VOID', note=$2 WHERE id=$1 RETURNING *`,
        [purchaseId, reason]
      );
      await c.query(
        `UPDATE tickets SET status='FREE', reserved_until=NULL, purchase_id=NULL
           WHERE slug=$1 AND number=$2`,
        [row.slug, row.number]
      );
      return mapPurchase(upd.rows[0]);
    });
  }

  async function findByReference(reference) {
    const { rows } = await q(`SELECT ${COLS_PURCHASE} FROM purchases WHERE reference=$1`, [reference]);
    return rows.length ? mapPurchase(rows[0]) : null;
  }

  async function alreadyProcessed(txId) {
    if (!txId) return false;
    const { rowCount } = await q(`SELECT 1 FROM processed_events WHERE transaction_id=$1`, [txId]);
    return rowCount > 0;
  }

  async function markProcessed(txId) {
    if (!txId) return;
    await q(`INSERT INTO processed_events (transaction_id) VALUES ($1) ON CONFLICT DO NOTHING`, [txId]);
  }

  async function soldPurchases(slug) {
    const { rows } = await q(
      `SELECT ${COLS_PURCHASE} FROM purchases WHERE slug=$1 AND status='APPROVED' ORDER BY number`, [slug]
    );
    return rows.map(mapPurchase);
  }

  async function declareWinner(slug, number, mechanism = "ADMIN_INPUT") {
    await getRaffle(slug);
    if (mechanism === "RANDOM_FROM_SOLD" && (number === undefined || number === null)) {
      const { rows } = await q(
        `SELECT number FROM purchases WHERE slug=$1 AND status='APPROVED' ORDER BY random() LIMIT 1`, [slug]
      );
      if (!rows.length) throw httpError(422, "No hay numeros vendidos para sortear");
      number = rows[0].number;
    }
    const t = await q(`SELECT status FROM tickets WHERE slug=$1 AND number=$2`, [slug, number]);
    if (!t.rows.length || t.rows[0].status !== "SOLD") {
      throw httpError(422, "El numero declarado no esta vendido (SOLD)");
    }
    const pr = await q(
      `SELECT ${COLS_PURCHASE} FROM purchases WHERE slug=$1 AND number=$2 AND status='APPROVED' LIMIT 1`, [slug, number]
    );
    const p = mapPurchase(pr.rows[0]);
    const winner = { number, buyer: p.buyerPublic, purchasedAt: p.purchasedAt, verifiedAt: p.verifiedAt };

    return tx(async (c) => {
      await c.query(`UPDATE raffles SET status='DRAWN', winner=$2 WHERE slug=$1`, [slug, JSON.stringify(winner)]);
      const d = await c.query(
        `INSERT INTO draws (slug, winning_number, mechanism, winner, status)
         VALUES ($1,$2,$3,$4,'VALID') RETURNING drawn_at`,
        [slug, number, mechanism, JSON.stringify(winner)]
      );
      return {
        raffleSlug: slug,
        drawnAt: iso(d.rows[0].drawn_at),
        winningNumber: number,
        mechanism,
        winner,
        status: "VALID",
      };
    });
  }

  async function publicRaffle(slug) {
    return getRaffle(slug); // ya es la forma publica (sin datos privados)
  }

  async function publicNumbers(slug) {
    await getRaffle(slug);
    const { rows } = await q(
      `SELECT number, buyer_public, purchased_at, verified_at
         FROM purchases WHERE slug=$1 AND status='APPROVED' ORDER BY number`,
      [slug]
    );
    return {
      version: new Date().toISOString(),
      sold: rows.map((r) => ({
        number: r.number,
        buyer: r.buyer_public,
        purchasedAt: iso(r.purchased_at),
        verifiedAt: iso(r.verified_at),
      })),
    };
  }

  async function listRaffles() {
    const { rows } = await q(
      `SELECT r.*, (SELECT count(*) FROM purchases p WHERE p.slug=r.slug AND p.status='APPROVED') AS sold
         FROM raffles r ORDER BY r.created_at`
    );
    return rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      status: r.status,
      sold: Number(r.sold),
      total: r.number_max - r.number_min + 1,
      priceCents: Number(r.price_cents),
      numberRange: { min: r.number_min, max: r.number_max },
      winner: r.winner || null,
      // Estado de publicacion: sin esto el admin muestra "Publicar" para siempre
      // y pierde el enlace al repo en cada recarga.
      publishedAt: iso(r.published_at),
      repoFullName: r.repo_full_name || null,
      prizeTotalCents: prizeTotalCents(r.prize_items || []),
      cover: r.media?.cover || null,
      createdAt: iso(r.created_at),
    }));
  }

  async function adminPurchases(slug, statusFilter) {
    // Columnas explicitas y NO `SELECT *`: receipt_image es un BYTEA de cientos
    // de KB. Con `*`, listar 100 compras traeria decenas de megas de imagenes
    // desde la base solo para descartarlas aqui. El comprobante se pide aparte.
    const { rows } = await q(
      `SELECT id, slug, number, method, status, reference, amount_cents, buyer_public,
              private, wompi_transaction_id, purchased_at, verified_at, approved_by,
              note, receipt_at
         FROM purchases WHERE slug=$1 AND ($2::text IS NULL OR status=$2)
        ORDER BY purchased_at`,
      [slug, statusFilter || null]
    );
    return rows.map((r) => {
      const p = mapPurchase(r);
      return {
        id: p.id, number: p.number, buyer: p.buyerPublic, method: p.method,
        status: p.status, purchasedAt: p.purchasedAt, verifiedAt: p.verifiedAt,
        hasReceipt: p.hasReceipt, receiptAt: p.receiptAt, contact: p.private,
      };
    });
  }

  /**
   * Libera las reservas vencidas.
   *
   * NUNCA toca una compra con comprobante adjunto, por vencida que este.
   * Sin esa guarda, el comprador paga por Nequi, sube el pantallazo, y el cron
   * le rechaza la compra y libera su numero mientras espera al administrador:
   * dinero real perdido y un numero vendido dos veces. Una compra con
   * comprobante solo sale de PENDING cuando un humano la aprueba o la rechaza.
   */
  async function expireReservations() {
    return tx(async (c) => {
      await c.query(
        `UPDATE purchases SET status='REJECTED', note='Reserva expirada'
           WHERE status='PENDING' AND receipt_at IS NULL AND id IN (
             SELECT purchase_id FROM tickets
              WHERE status='RESERVED' AND reserved_until < now() AND purchase_id IS NOT NULL)`
      );
      const r = await c.query(
        `UPDATE tickets SET status='FREE', reserved_until=NULL, purchase_id=NULL
           WHERE status='RESERVED' AND reserved_until < now()
             AND (purchase_id IS NULL OR purchase_id IN (
               SELECT id FROM purchases WHERE receipt_at IS NULL))`
      );
      return r.rowCount;
    });
  }

  // ------------------------------------------------------------------
  // Autenticacion / autorizacion
  // ------------------------------------------------------------------
  const mapAdmin = (u) => u && ({
    id: u.id, email: u.email, passwordHash: u.password_hash,
    totpSecret: u.totp_secret, totpEnabled: u.totp_enabled,
    role: u.role, lastLoginAt: iso(u.last_login_at),
  });

  async function countAdmins() {
    const { rows } = await q(`SELECT count(*)::int AS c FROM admin_users`);
    return rows[0].c;
  }

  async function createAdmin({ email, passwordHash, role = "ADMIN" }) {
    const id = crypto.randomUUID();
    const { rows } = await q(
      `INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO NOTHING RETURNING *`,
      [id, String(email).toLowerCase().trim(), passwordHash, role]
    );
    if (!rows.length) throw httpError(409, "Ya existe un administrador con ese correo");
    return mapAdmin(rows[0]);
  }

  async function getAdminByEmail(email) {
    const { rows } = await q(`SELECT * FROM admin_users WHERE email=$1`, [String(email || "").toLowerCase().trim()]);
    return rows.length ? mapAdmin(rows[0]) : null;
  }

  async function getAdminById(id) {
    const { rows } = await q(`SELECT * FROM admin_users WHERE id=$1`, [id]);
    return rows.length ? mapAdmin(rows[0]) : null;
  }

  async function setAdminTotp(id, secret, enabled) {
    const { rows } = await q(
      `UPDATE admin_users SET totp_secret=$2, totp_enabled=$3 WHERE id=$1 RETURNING *`,
      [id, secret, enabled]
    );
    if (!rows.length) throw httpError(404, "Administrador no encontrado");
    return mapAdmin(rows[0]);
  }

  async function touchAdminLogin(id) {
    await q(`UPDATE admin_users SET last_login_at=now() WHERE id=$1`, [id]);
  }

  async function saveRefreshToken(tokenHash, userId, expiresAt) {
    await q(
      `INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES ($1,$2,$3)`,
      [tokenHash, userId, expiresAt]
    );
  }

  /** Devuelve el token solo si existe, no fue revocado y no expiro. */
  async function getRefreshToken(tokenHash) {
    const { rows } = await q(
      `SELECT * FROM refresh_tokens
        WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()`,
      [tokenHash]
    );
    return rows.length ? { tokenHash: rows[0].token_hash, userId: rows[0].user_id } : null;
  }

  async function revokeRefreshToken(tokenHash) {
    await q(`UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL`, [tokenHash]);
  }

  async function audit({ actor = null, action, entityType = null, entityId = null, before = null, after = null }) {
    await q(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id, before, after)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [actor, action, entityType, entityId ? String(entityId) : null,
       before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
    );
  }

  // ------------------------------------------------------------------
  // Rate limiting
  // ------------------------------------------------------------------
  /** Incremento ATOMICO: dos contenedores concurrentes no pierden cuentas. */
  async function hitRateLimit(bucket, expiresAt) {
    const { rows } = await q(
      `INSERT INTO rate_limits (bucket, hits, expires_at) VALUES ($1, 1, $2)
       ON CONFLICT (bucket) DO UPDATE SET hits = rate_limits.hits + 1
       RETURNING hits`,
      [bucket, expiresAt]
    );
    return rows[0].hits;
  }

  async function cleanupRateLimits() {
    const r = await q(`DELETE FROM rate_limits WHERE expires_at < now()`);
    return r.rowCount;
  }

  async function close() { await pool.end(); }

  return {
    kind: "postgres",
    createRaffle, getRaffle, updateRaffle, markPublished,
    reserve, getPurchase, attachReceipt, getReceipt, approve, reject, voidPurchase, markSold,
    findByReference, alreadyProcessed, markProcessed, declareWinner,
    publicRaffle, paymentInfo, publicNumbers, heldNumbers, expireReservations, soldPurchases,
    listRaffles, adminPurchases,
    countAdmins, createAdmin, getAdminByEmail, getAdminById, setAdminTotp, touchAdminLogin,
    saveRefreshToken, getRefreshToken, revokeRefreshToken, audit,
    hitRateLimit, cleanupRateLimits,
    close, _pool: pool,
  };
}
