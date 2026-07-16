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
    "TRUNCATE tickets, purchases, draws, processed_events, audit_log, refresh_tokens, admin_users, rate_limits, raffles CASCADE"
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

// --------------------------- Anulacion en PostgreSQL ---------------------------
test("postgres: anular venta libera el numero y lo saca del publico", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createRaffle(RAFFLE);
    const p = await store.reserve("pg-test", 12, { firstName: "Ana", lastName: "Gomez" });
    await store.approve(p.id);
    assert.equal((await store.publicNumbers("pg-test")).sold.length, 1);

    const anulada = await store.voidPurchase(p.id, { reason: "cobro por error" });
    assert.equal(anulada.status, "VOID");
    assert.equal((await store.publicNumbers("pg-test")).sold.length, 0);

    // El ticket quedo realmente libre en la base (no solo en la vista publica).
    const { rows } = await store._pool.query(
      "SELECT status, purchase_id FROM tickets WHERE slug='pg-test' AND number=12"
    );
    assert.equal(rows[0].status, "FREE");
    assert.equal(rows[0].purchase_id, null);

    // Y otro comprador puede tomarlo.
    assert.equal((await store.reserve("pg-test", 12, { firstName: "Otro", lastName: "Comprador" })).number, 12);
  } finally { await store.close(); }
});

test("postgres: no se puede anular al ganador declarado", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createRaffle(RAFFLE);
    const p = await store.reserve("pg-test", 15, { firstName: "Nina", lastName: "Rojas" });
    await store.approve(p.id);
    await store.declareWinner("pg-test", 15, "ADMIN_INPUT");
    await assert.rejects(() => store.voidPurchase(p.id), /ganador/);
    // Y la venta sigue intacta tras el rechazo (la transaccion no dejo residuos).
    assert.equal((await store.getPurchase(p.id)).status, "APPROVED");
    assert.equal((await store.publicNumbers("pg-test")).sold.length, 1);
  } finally { await store.close(); }
});

// --------------------------- Rate limiting en PostgreSQL ---------------------------
// Lo critico: el contador debe ser ATOMICO. En serverless hay muchos contenedores
// concurrentes; si el incremento perdiera cuentas, el limite seria evadible.

test("postgres: el contador de rate limit es atomico bajo concurrencia", { skip }, async () => {
  const store = await freshStore();
  try {
    const expira = new Date(Date.now() + 60_000);
    // 30 incrementos EN PARALELO sobre el mismo bucket.
    const resultados = await Promise.all(
      Array.from({ length: 30 }, () => store.hitRateLimit("concurrente", expira))
    );
    // Ninguna cuenta perdida: el maximo debe ser exactamente 30...
    assert.equal(Math.max(...resultados), 30, "se perdieron incrementos: NO es atomico");
    // ...y cada llamada debe haber visto un valor distinto (1..30).
    assert.equal(new Set(resultados).size, 30, "hubo valores repetidos: condicion de carrera");

    const { rows } = await store._pool.query("SELECT hits FROM rate_limits WHERE bucket='concurrente'");
    assert.equal(rows[0].hits, 30);
  } finally { await store.close(); }
});

test("postgres: cleanupRateLimits borra solo lo vencido", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.hitRateLimit("vencida", new Date(Date.now() - 5000));
    await store.hitRateLimit("vigente", new Date(Date.now() + 60_000));
    assert.equal(await store.cleanupRateLimits(), 1);
    const { rows } = await store._pool.query("SELECT bucket FROM rate_limits");
    assert.deepEqual(rows.map((r) => r.bucket), ["vigente"]);
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

// --------------------------- Pago manual (v1.7.0) ---------------------------
// El caso que cuesta dinero de verdad. Se prueba contra PostgreSQL porque la
// guarda vive en SQL (el WHERE del reclamo y el del cron), no en JavaScript:
// probarla solo en memoria no diria nada de produccion.

const PNG_MINIMO = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

test("postgres CRITICO: la compra con comprobante no expira ni la roba otro", { skip }, async () => {
  const store = await createPostgresStore(URL_DB, { reserveMinutes: -1 }); // nace vencida
  try {
    assertTestDatabase(URL_DB);
    await store._pool.query("TRUNCATE tickets, purchases, raffles CASCADE");
    await store.createRaffle(RAFFLE);
    const p = await store.reserve("pg-test", 7, { firstName: "Ana", lastName: "Gomez" }, "MANUAL");
    await store.attachReceipt(p.id, { bytes: PNG_MINIMO, mime: "image/png" });

    // 1) El cron no la toca.
    assert.equal(await store.expireReservations(), 0, "el cron no debe soltar un numero ya pagado");
    assert.equal((await store.getPurchase(p.id)).status, "PENDING");

    // 2) Y otro comprador tampoco puede reclamarlo, aunque la reserva este vencida.
    await assert.rejects(
      () => store.reserve("pg-test", 7, { firstName: "Otro", lastName: "Vivo" }, "MANUAL"),
      /no disponible/,
      "otro comprador NO puede quedarse con un numero que ya se pago",
    );
  } finally { await store.close(); }
});

test("postgres: sin comprobante, la reserva vencida si se libera", { skip }, async () => {
  const store = await createPostgresStore(URL_DB, { reserveMinutes: -1 });
  try {
    assertTestDatabase(URL_DB);
    await store._pool.query("TRUNCATE tickets, purchases, raffles CASCADE");
    await store.createRaffle(RAFFLE);
    const p = await store.reserve("pg-test", 8, { firstName: "Ana", lastName: "Gomez" }, "MANUAL");
    assert.equal(await store.expireReservations(), 1);
    assert.equal((await store.getPurchase(p.id)).status, "REJECTED");
    const p2 = await store.reserve("pg-test", 8, { firstName: "Otro", lastName: "Comprador" }, "MANUAL");
    assert.equal(p2.number, 8);
  } finally { await store.close(); }
});

test("postgres: el comprobante se guarda intacto y no viaja en los listados", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createRaffle(RAFFLE);
    const p = await store.reserve("pg-test", 9, { firstName: "Ana", lastName: "Gomez" }, "MANUAL");
    await store.attachReceipt(p.id, { bytes: PNG_MINIMO, mime: "image/png" });

    // Los bytes vuelven tal cual (BYTEA de ida y vuelta).
    const r = await store.getReceipt(p.id);
    assert.deepEqual(r.bytes, PNG_MINIMO);
    assert.equal(r.mime, "image/png");

    // Pero el listado solo dice que existe: la imagen no cruza la red por fila.
    const [fila] = await store.adminPurchases("pg-test", "PENDING");
    assert.equal(fila.hasReceipt, true);
    assert.ok(fila.receiptAt);
    assert.equal(JSON.stringify(fila).includes("receipt_image"), false);
    assert.equal("receiptImage" in fila, false);
  } finally { await store.close(); }
});

test("postgres: la pasarela apagada rechaza la reserva WOMPI", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createRaffle({ ...RAFFLE, gatewayEnabled: false });
    await assert.rejects(
      () => store.reserve("pg-test", 3, { firstName: "Ana", lastName: "Gomez" }, "WOMPI"),
      /pasarela/i,
    );
    const p = await store.reserve("pg-test", 3, { firstName: "Ana", lastName: "Gomez" }, "MANUAL");
    assert.equal(p.method, "MANUAL");
  } finally { await store.close(); }
});

test("postgres: los medios de pago no se publican; drawAt si", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.createRaffle({
      ...RAFFLE,
      drawAt: "2026-08-20T00:00:00-05:00",
      paymentMethods: [{ label: "Nequi", value: "3200000000", hint: "A nombre de Jhon S." }],
    });
    const pub = await store.publicRaffle("pg-test");
    assert.equal(pub.drawAt, new Date("2026-08-20T00:00:00-05:00").toISOString());
    assert.ok(!JSON.stringify(pub).includes("3200000000"), "la cuenta no se publica");

    const info = await store.paymentInfo("pg-test");
    assert.equal(info.paymentMethods[0].value, "3200000000");
  } finally { await store.close(); }
});

test("postgres: la base rechaza un sorteo anterior al cierre", { skip }, async () => {
  const store = await freshStore();
  try {
    await assert.rejects(
      () => store.createRaffle({ ...RAFFLE, drawAt: "2026-08-01T00:00:00-05:00" }), // antes de ends_at
      /antes/i,
    );
  } finally { await store.close(); }
});
