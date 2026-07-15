// Store persistente en PostgreSQL. Misma interfaz que el store en memoria
// (metodos async). Se activa cuando DATABASE_URL esta definida.
//
// Atomicidad de reserva (Guia 6.4): el UPDATE condicional sobre `tickets`
// (WHERE status='FREE' OR reserva expirada) toma el row lock; una transaccion
// concurrente se bloquea y luego ve RESERVED -> rowCount 0 -> 409.

import fs from "node:fs";
import crypto from "node:crypto";
import { httpError, pseudonym } from "./store.js";

const MIGRATION_URL = new URL("../../../infra/db/migrations/001_init.sql", import.meta.url);

const iso = (d) => (d ? new Date(d).toISOString() : null);

function mapRaffle(r) {
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
    minSoldToDraw: r.min_sold_to_draw,
    status: r.status,
    winner: r.winner || null,
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
    receiptUrl: p.receipt_url,
    wompiTransactionId: p.wompi_transaction_id,
    purchasedAt: iso(p.purchased_at),
    verifiedAt: iso(p.verified_at),
    approvedBy: p.approved_by,
    note: p.note,
  };
}

export async function createPostgresStore(databaseUrl, { reserveMinutes = 15 } = {}) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });

  // Migracion idempotente al arrancar.
  if (!fs.existsSync(MIGRATION_URL)) {
    throw new Error(`No se encontro la migracion: ${MIGRATION_URL.pathname}`);
  }
  await pool.query(fs.readFileSync(MIGRATION_URL, "utf8"));

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
    await tx(async (c) => {
      await c.query(
        `INSERT INTO raffles (slug,title,description,prize,price_cents,currency,number_min,number_max,starts_at,ends_at,min_sold_to_draw,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (slug) DO NOTHING`,
        [cfg.slug, cfg.title, cfg.description || "", cfg.prize, cfg.priceCents, cfg.currency || "COP",
         cfg.numberRange.min, cfg.numberRange.max, cfg.startsAt, cfg.endsAt, cfg.minSoldToDraw ?? 0, cfg.status || "ACTIVE"]
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

  async function reserve(slug, number, buyer, method = "MANUAL") {
    const raffle = await getRaffle(slug);
    if (number < raffle.numberRange.min || number > raffle.numberRange.max) {
      throw httpError(404, "Numero fuera de rango");
    }
    const id = crypto.randomUUID();
    const reference = `RAFFLE-${slug}-NUM-${number}-${id}`;
    const until = new Date(Date.now() + reserveMinutes * 60_000);

    return tx(async (c) => {
      // 1) Reclamo atomico del numero (libre o con reserva vencida).
      const claim = await c.query(
        `UPDATE tickets SET status='RESERVED', reserved_until=$3
           WHERE slug=$1 AND number=$2
             AND (status='FREE' OR (status='RESERVED' AND reserved_until < now()))
         RETURNING number`,
        [slug, number, until]
      );
      if (claim.rowCount === 0) throw httpError(409, "Numero no disponible");

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
    const { rows } = await q(`SELECT * FROM purchases WHERE id=$1`, [id]);
    if (!rows.length) throw httpError(404, "Compra no encontrada");
    return mapPurchase(rows[0]);
  }

  async function attachReceipt(purchaseId, receiptUrl) {
    const { rows } = await q(`UPDATE purchases SET receipt_url=$2 WHERE id=$1 RETURNING *`, [purchaseId, receiptUrl]);
    if (!rows.length) throw httpError(404, "Compra no encontrada");
    return mapPurchase(rows[0]);
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
        const cur = await c.query(`SELECT * FROM purchases WHERE id=$1`, [purchase.id]);
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

  async function findByReference(reference) {
    const { rows } = await q(`SELECT * FROM purchases WHERE reference=$1`, [reference]);
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
      `SELECT * FROM purchases WHERE slug=$1 AND status='APPROVED' ORDER BY number`, [slug]
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
      `SELECT * FROM purchases WHERE slug=$1 AND number=$2 AND status='APPROVED' LIMIT 1`, [slug, number]
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
    }));
  }

  async function adminPurchases(slug, statusFilter) {
    const { rows } = await q(
      `SELECT * FROM purchases WHERE slug=$1 AND ($2::text IS NULL OR status=$2)
       ORDER BY purchased_at`,
      [slug, statusFilter || null]
    );
    return rows.map((r) => {
      const p = mapPurchase(r);
      return {
        id: p.id, number: p.number, buyer: p.buyerPublic, method: p.method,
        status: p.status, purchasedAt: p.purchasedAt, verifiedAt: p.verifiedAt,
        receiptUrl: p.receiptUrl, contact: p.private,
      };
    });
  }

  async function expireReservations() {
    return tx(async (c) => {
      await c.query(
        `UPDATE purchases SET status='REJECTED', note='Reserva expirada'
           WHERE status='PENDING' AND id IN (
             SELECT purchase_id FROM tickets
              WHERE status='RESERVED' AND reserved_until < now() AND purchase_id IS NOT NULL)`
      );
      const r = await c.query(
        `UPDATE tickets SET status='FREE', reserved_until=NULL, purchase_id=NULL
           WHERE status='RESERVED' AND reserved_until < now()`
      );
      return r.rowCount;
    });
  }

  async function close() { await pool.end(); }

  return {
    kind: "postgres",
    createRaffle, getRaffle, reserve, getPurchase, attachReceipt, approve, reject, markSold,
    findByReference, alreadyProcessed, markProcessed, declareWinner,
    publicRaffle, publicNumbers, expireReservations, soldPurchases,
    listRaffles, adminPurchases, close, _pool: pool,
  };
}
