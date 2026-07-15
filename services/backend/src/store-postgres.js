// Store persistente en PostgreSQL. Misma interfaz que el store en memoria
// (metodos async). Se activa cuando DATABASE_URL esta definida.
//
// Atomicidad de reserva (Guia 6.4): el UPDATE condicional sobre `tickets`
// (WHERE status='FREE' OR reserva expirada) toma el row lock; una transaccion
// concurrente se bloquea y luego ve RESERVED -> rowCount 0 -> 409.

import fs from "node:fs";
import crypto from "node:crypto";
import { httpError, pseudonym } from "./store.js";

// Las migraciones viven junto al servicio para que viajen con el despliegue.
const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

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

  // Proveedores gestionados (Neon, Vercel Postgres) exigen TLS; en local no.
  const isLocal = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(databaseUrl);
  // En serverless conviene un pool pequeño: hay muchos contenedores concurrentes.
  const defaultMax = isLocal ? 10 : 3;

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PG_POOL_MAX || defaultMax),
    ssl: isLocal ? false : { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== "true" },
  });

  // Migraciones idempotentes al arrancar, en orden alfabetico (001_, 002_, ...).
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  if (!files.length) throw new Error(`Sin migraciones en ${MIGRATIONS_DIR.pathname}`);
  for (const f of files) {
    await pool.query(fs.readFileSync(new URL(f, MIGRATIONS_DIR), "utf8"));
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

  async function close() { await pool.end(); }

  return {
    kind: "postgres",
    createRaffle, getRaffle, reserve, getPurchase, attachReceipt, approve, reject, markSold,
    findByReference, alreadyProcessed, markProcessed, declareWinner,
    publicRaffle, publicNumbers, expireReservations, soldPurchases,
    listRaffles, adminPurchases,
    countAdmins, createAdmin, getAdminByEmail, getAdminById, setAdminTotp, touchAdminLogin,
    saveRefreshToken, getRefreshToken, revokeRefreshToken, audit,
    close, _pool: pool,
  };
}
