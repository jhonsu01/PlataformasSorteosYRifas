// Pruebas contra PostgreSQL REAL. Se saltan si no hay DATABASE_URL.
// En CI (.github/workflows/ci.yml) corren contra un service container postgres:16.
//
// Ejecutar en local (con Docker):
//   docker run --rm -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=sorteos_test -p 5432:5432 -d postgres:16
//   DATABASE_URL=postgres://postgres:postgres@localhost:5432/sorteos_test npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresStore } from "../src/store-postgres.js";
import { hashPassword, totpCode } from "../src/crypto-utils.js";
import { login, refreshSession, setupTotp, enableTotp } from "../src/auth.js";

const URL_DB = process.env.DATABASE_URL;
const skip = !URL_DB ? "sin DATABASE_URL" : false;

const RAFFLE = {
  slug: "pg-test",
  title: "Rifa PG",
  prize: "Premio PG",
  priceCents: 500000,
  currency: "COP",
  numberRange: { min: 0, max: 20 },
  startsAt: "2026-07-14T00:00:00-05:00",
  endsAt: "2026-08-14T00:00:00-05:00",
  minSoldToDraw: 1,
};

// SALVAGUARDA: estas pruebas hacen TRUNCATE. Si DATABASE_URL apuntara por error a
// una base real (p. ej. un PostgreSQL local ya instalado en el puerto por defecto),
// se destruirian datos. Solo permitimos bases cuyo nombre indique que son de prueba.
function assertTestDatabase(connString) {
  const dbName = new URL(connString).pathname.replace(/^\//, "");
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Abortado por seguridad: DATABASE_URL apunta a la base "${dbName}", que no parece de pruebas ` +
      `(el nombre debe contener "test"). Estas pruebas ejecutan TRUNCATE.`
    );
  }
  return dbName;
}

async function freshStore() {
  assertTestDatabase(URL_DB);
  const store = await createPostgresStore(URL_DB, { reserveMinutes: 15 });
  // Limpia el estado de pruebas previas.
  await store._pool.query(
    "TRUNCATE tickets, purchases, draws, processed_events, audit_log, refresh_tokens, admin_users, raffles CASCADE"
  );
  return store;
}

test("postgres: crea rifa y genera todos los tickets", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createRaffle(RAFFLE);
    const r = await store.getRaffle("pg-test");
    assert.equal(r.title, "Rifa PG");
    assert.equal(r.numberRange.max, 20);
    const { rows } = await store._pool.query("SELECT count(*)::int AS c FROM tickets WHERE slug='pg-test'");
    assert.equal(rows[0].c, 21); // 0..20 inclusive
  } finally { await store.close(); }
});

test("postgres: reserva atomica — el mismo numero no se vende dos veces", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createRaffle(RAFFLE);
    await store.reserve("pg-test", 5, { firstName: "Juan", lastName: "Sanchez" });
    await assert.rejects(
      () => store.reserve("pg-test", 5, { firstName: "Otra", lastName: "Persona" }),
      /no disponible/
    );
  } finally { await store.close(); }
});

test("postgres: reservas concurrentes — solo una gana", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createRaffle(RAFFLE);
    const intentos = Array.from({ length: 8 }, (_, i) =>
      store.reserve("pg-test", 9, { firstName: `User${i}`, lastName: "Test" }).then(
        () => "ok",
        () => "fail"
      )
    );
    const res = await Promise.all(intentos);
    assert.equal(res.filter((r) => r === "ok").length, 1, "solo una reserva debe ganar");
  } finally { await store.close(); }
});

test("postgres: el estado publico no filtra datos privados", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createRaffle(RAFFLE);
    const p = await store.reserve("pg-test", 3, {
      firstName: "Ana", lastName: "Gomez",
      phone: "3001234567", email: "ana@correo.com", document: "123456",
    });
    await store.approve(p.id, { approvedBy: "admin" });

    const pub = await store.publicNumbers("pg-test");
    assert.equal(pub.sold.length, 1);
    assert.deepEqual(Object.keys(pub.sold[0]).sort(), ["buyer", "number", "purchasedAt", "verifiedAt"]);
    assert.equal(pub.sold[0].buyer, "Ana G.");

    const serialized = JSON.stringify(pub);
    for (const secreto of ["3001234567", "ana@correo.com", "123456", "Gomez"]) {
      assert.ok(!serialized.includes(secreto), `fuga de dato privado: ${secreto}`);
    }
  } finally { await store.close(); }
});

test("postgres: PERSISTENCIA — los datos sobreviven a un reinicio", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createRaffle(RAFFLE);
    const p = await store.reserve("pg-test", 11, { firstName: "Leo", lastName: "Diaz" });
    await store.approve(p.id);
  } finally { await store.close(); } // simula apagar el backend

  // Nueva instancia (nuevo pool) contra la misma base: simula reiniciar.
  const store2 = await createPostgresStore(URL_DB, { reserveMinutes: 15 });
  try {
    const pub = await store2.publicNumbers("pg-test");
    assert.equal(pub.sold.length, 1, "la venta debe seguir ahi tras reiniciar");
    assert.equal(pub.sold[0].number, 11);
    assert.equal(pub.sold[0].buyer, "Leo D.");
    const raffles = await store2.listRaffles();
    assert.equal(raffles.find((r) => r.slug === "pg-test").sold, 1);
  } finally { await store2.close(); }
});

test("postgres: webhook idempotente por transaction_id", { skip }, async () => {
  const store = await freshStore();
  try {
    assert.equal(await store.alreadyProcessed("txn_abc"), false);
    await store.markProcessed("txn_abc");
    assert.equal(await store.alreadyProcessed("txn_abc"), true);
    await store.markProcessed("txn_abc"); // no debe lanzar (ON CONFLICT DO NOTHING)
  } finally { await store.close(); }
});

test("postgres: rechazar libera el numero", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createRaffle(RAFFLE);
    const p = await store.reserve("pg-test", 4, { firstName: "Sara", lastName: "Lopez" });
    await store.reject(p.id, { reason: "comprobante ilegible" });
    // Al quedar libre, otro comprador puede tomarlo.
    const p2 = await store.reserve("pg-test", 4, { firstName: "Otro", lastName: "Comprador" });
    assert.equal(p2.number, 4);
  } finally { await store.close(); }
});

test("postgres: declarar ganador exige numero vendido", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createRaffle(RAFFLE);
    await assert.rejects(() => store.declareWinner("pg-test", 8), /no esta vendido/);

    const p = await store.reserve("pg-test", 8, { firstName: "Nina", lastName: "Rojas" });
    await store.approve(p.id);
    const draw = await store.declareWinner("pg-test", 8, "ADMIN_INPUT");
    assert.equal(draw.winningNumber, 8);
    assert.equal(draw.winner.buyer, "Nina R.");

    const r = await store.getRaffle("pg-test");
    assert.equal(r.status, "DRAWN");
    assert.equal(r.winner.number, 8);
  } finally { await store.close(); }
});

// --------------------------- Auth contra PostgreSQL ---------------------------
// El store en memoria ya se prueba en auth.test.js; aqui se valida el camino REAL
// de produccion (SQL de admin_users / refresh_tokens / audit_log).

test("postgres: alta de admin, correo unico y login", { skip }, async () => {
  const store = await freshStore();
  try {
    const u = await store.createAdmin({ email: "Admin@Test.com", passwordHash: await hashPassword("clave-larga-123"), role: "SUPER_ADMIN" });
    assert.equal(u.email, "admin@test.com", "el correo se normaliza a minusculas");
    assert.equal(u.role, "SUPER_ADMIN");

    await assert.rejects(
      () => store.createAdmin({ email: "admin@test.com", passwordHash: "x", role: "ADMIN" }),
      /Ya existe/
    );

    const s = await login(store, { email: "admin@test.com", password: "clave-larga-123" });
    assert.ok(s.accessToken && s.refreshToken);
    const fresh = await store.getAdminByEmail("admin@test.com");
    assert.ok(fresh.lastLoginAt, "debe registrar el ultimo acceso");
  } finally { await store.close(); }
});

test("postgres: refresh rota y persiste; el token viejo queda revocado", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createAdmin({ email: "a@test.com", passwordHash: await hashPassword("clave-larga-123") });
    const s1 = await login(store, { email: "a@test.com", password: "clave-larga-123" });
    const s2 = await refreshSession(store, s1.refreshToken);
    assert.notEqual(s2.refreshToken, s1.refreshToken);
    await assert.rejects(() => refreshSession(store, s1.refreshToken), /invalido o expirado/);
    // El refresh nuevo si sirve.
    assert.ok((await refreshSession(store, s2.refreshToken)).accessToken);
  } finally { await store.close(); }
});

test("postgres: el refresh se guarda hasheado, nunca en claro", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createAdmin({ email: "b@test.com", passwordHash: await hashPassword("clave-larga-123") });
    const s = await login(store, { email: "b@test.com", password: "clave-larga-123" });
    const { rows } = await store._pool.query("SELECT token_hash FROM refresh_tokens");
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, s.refreshToken, "el token en claro NO debe estar en la base");
    assert.match(rows[0].token_hash, /^[a-f0-9]{64}$/, "debe ser un sha256");
  } finally { await store.close(); }
});

test("postgres: 2FA con TOTP persiste y se exige en el login", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createAdmin({ email: "c@test.com", passwordHash: await hashPassword("clave-larga-123") });
    const user = await store.getAdminByEmail("c@test.com");
    const { secret } = await setupTotp(store, user);
    await enableTotp(store, user, totpCode(secret));

    const guardado = await store.getAdminByEmail("c@test.com");
    assert.equal(guardado.totpEnabled, true);

    await assert.rejects(
      () => login(store, { email: "c@test.com", password: "clave-larga-123" }),
      (e) => e.totpRequired === true
    );
    const s = await login(store, { email: "c@test.com", password: "clave-larga-123", totp: totpCode(secret) });
    assert.equal(s.mustEnable2fa, false);
  } finally { await store.close(); }
});

test("postgres: la auditoria registra las acciones", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createAdmin({ email: "d@test.com", passwordHash: await hashPassword("clave-larga-123") });
    await login(store, { email: "d@test.com", password: "clave-larga-123" });
    await store.audit({ actor: "d@test.com", action: "APPROVE_PURCHASE", entityType: "purchase", entityId: "x1", after: { number: 5 } });
    const { rows } = await store._pool.query("SELECT actor, action, after FROM audit_log ORDER BY id");
    const acciones = rows.map((r) => r.action);
    assert.ok(acciones.includes("LOGIN"), "el login debe auditarse");
    assert.ok(acciones.includes("APPROVE_PURCHASE"));
    assert.equal(rows.find((r) => r.action === "APPROVE_PURCHASE").after.number, 5);
  } finally { await store.close(); }
});

test("postgres: sorteo aleatorio elige entre los vendidos", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createRaffle(RAFFLE);
    for (const [n, f] of [[1, "Ana"], [2, "Beto"], [3, "Caro"]]) {
      const p = await store.reserve("pg-test", n, { firstName: f, lastName: "Test" });
      await store.approve(p.id);
    }
    const draw = await store.declareWinner("pg-test", null, "RANDOM_FROM_SOLD");
    assert.ok([1, 2, 3].includes(draw.winningNumber));
    assert.equal(draw.mechanism, "RANDOM_FROM_SOLD");
  } finally { await store.close(); }
});
