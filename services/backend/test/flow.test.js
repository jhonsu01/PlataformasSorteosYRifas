import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, pseudonym } from "../src/store.js";
import { computeEventChecksum, verifyEventSignature, actionForStatus } from "../src/wompi.js";

function demoRaffle(store) {
  store.createRaffle({
    slug: "t",
    title: "Test",
    prize: "Premio",
    priceCents: 1000000,
    currency: "COP",
    numberRange: { min: 0, max: 9 },
    startsAt: "2026-07-14T00:00:00-05:00",
    endsAt: "2026-08-14T00:00:00-05:00",
    minSoldToDraw: 1,
  });
}

test("seudonimo = nombre + inicial del apellido", () => {
  assert.equal(pseudonym("juan", "Sanchez"), "Juan S.");
  assert.equal(pseudonym("MARIA", "perez"), "Maria P.");
});

test("reserva atomica: no se puede reservar dos veces el mismo numero", () => {
  const store = createStore();
  demoRaffle(store);
  store.reserve("t", 5, { firstName: "Juan", lastName: "Sanchez" });
  assert.throws(() => store.reserve("t", 5, { firstName: "Otra", lastName: "Persona" }), /apartado por otra persona/);
});

test("flujo compra->aprobacion->publico: solo campos permitidos, sin datos privados", () => {
  const store = createStore();
  demoRaffle(store);
  const p = store.reserve("t", 3, {
    firstName: "Ana",
    lastName: "Gomez",
    phone: "3001234567",     // privado
    email: "ana@correo.com", // privado
    document: "123456",      // privado
  });
  store.approve(p.id, { approvedBy: "admin" });

  const pub = store.publicNumbers("t");
  assert.equal(pub.sold.length, 1);
  const item = pub.sold[0];
  assert.deepEqual(Object.keys(item).sort(), ["buyer", "number", "purchasedAt", "verifiedAt"]);
  assert.equal(item.buyer, "Ana G.");
  assert.equal(item.number, 3);
  assert.ok(item.verifiedAt);

  // El JSON publico serializado NO debe contener ningun dato privado.
  const serialized = JSON.stringify(pub);
  for (const secret of ["3001234567", "ana@correo.com", "123456", "Gomez"]) {
    assert.ok(!serialized.includes(secret), `fuga de dato privado: ${secret}`);
  }
});

test("declarar ganador exige numero SOLD", () => {
  const store = createStore();
  demoRaffle(store);
  // Numero 7 nunca vendido -> rechaza.
  assert.throws(() => store.declareWinner("t", 7), /no esta vendido/);

  const p = store.reserve("t", 7, { firstName: "Leo", lastName: "Diaz" });
  store.approve(p.id);
  const draw = store.declareWinner("t", 7, "ADMIN_INPUT");
  assert.equal(draw.winningNumber, 7);
  assert.equal(draw.winner.buyer, "Leo D.");
  assert.equal(draw.status, "VALID");
});

test("mapeo de estado Wompi -> accion", () => {
  assert.equal(actionForStatus("APPROVED"), "SELL");
  assert.equal(actionForStatus("DECLINED"), "RELEASE");
  assert.equal(actionForStatus("VOIDED"), "RELEASE");
  assert.equal(actionForStatus("PENDING"), "WAIT");
});

test("verificacion de firma del webhook Wompi (roundtrip)", () => {
  const secret = "test_events_secret";
  const event = {
    event: "transaction.updated",
    data: { transaction: { id: "txn_123", reference: "RAFFLE-t-NUM-3-abc", status: "APPROVED", amount_in_cents: 1000000 } },
    timestamp: 1700000000,
    signature: { properties: ["transaction.id", "transaction.status", "transaction.amount_in_cents"], checksum: "" },
  };
  event.signature.checksum = computeEventChecksum(event, secret);
  assert.equal(verifyEventSignature(event, secret), true);

  // Con secreto equivocado -> falla.
  assert.equal(verifyEventSignature(event, "otro_secret"), false);
  // Con checksum manipulado -> falla.
  const tampered = { ...event, signature: { ...event.signature, checksum: "DEADBEEF" } };
  assert.equal(verifyEventSignature(tampered, secret), false);
});

// --------------------------- Anulacion de ventas ---------------------------
test("anular venta: libera el numero y lo saca del estado publico", async () => {
  const store = createStore();
  demoRaffle(store);
  const p = store.reserve("t", 4, { firstName: "Ana", lastName: "Gomez" });
  store.approve(p.id);
  assert.equal(store.publicNumbers("t").sold.length, 1);

  store.voidPurchase(p.id, { reason: "cobro por error" });
  assert.equal(store.publicNumbers("t").sold.length, 0, "debe salir del estado publico");

  // El numero vuelve a estar libre para otro comprador.
  const p2 = store.reserve("t", 4, { firstName: "Otro", lastName: "Comprador" });
  assert.equal(p2.number, 4);
});

test("anular venta: solo sobre ventas aprobadas", async () => {
  const store = createStore();
  demoRaffle(store);
  const p = store.reserve("t", 5, { firstName: "Ana", lastName: "Gomez" });
  // Pendiente: no se anula, se rechaza.
  assert.throws(() => store.voidPurchase(p.id), /aprobada/);
  assert.throws(() => store.voidPurchase("no-existe"), /no encontrada/);
});

test("anular venta: NO se puede anular al ganador ya declarado", async () => {
  const store = createStore();
  demoRaffle(store);
  const p = store.reserve("t", 6, { firstName: "Ana", lastName: "Gomez" });
  store.approve(p.id);
  store.declareWinner("t", 6, "ADMIN_INPUT");
  // Anularlo dejaria draw.json apuntando a un numero sin vender.
  assert.throws(() => store.voidPurchase(p.id), /ganador/);
});
