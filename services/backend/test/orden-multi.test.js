// Compra de VARIOS numeros (hasta 10) con UN solo pago (orden).
// Cubre: reserva por lote atomica, aprobar/rechazar por orden, comprobante de
// orden, y el tope de 10. La compra de un numero sigue siendo una orden de 1.

import test from "node:test";
import assert from "node:assert/strict";
import { createStore, MAX_NUMBERS_PER_ORDER } from "../src/store.js";

const nueva = (store) =>
  store.createRaffle({
    slug: "t", title: "T", prize: "P", priceCents: 1000000, currency: "COP",
    numberRange: { min: 0, max: 99 }, startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 864e5).toISOString(), minSoldToDraw: 0, status: "ACTIVE",
  });

const buyer = { firstName: "Ana", lastName: "Gomez", phone: "3001112233", city: "Bogota" };
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

test("reserveMany aparta N numeros bajo UNA orden y calcula el total", () => {
  const store = createStore();
  nueva(store);
  const orden = store.reserveMany("t", [1, 2, 3], buyer, "WOMPI");

  assert.equal(orden.count, 3);
  assert.equal(orden.totalCents, 3 * 1000000, "total = N x precio");
  assert.equal(orden.purchases.length, 3);
  // Todos comparten el mismo order_ref.
  const refs = new Set(orden.purchases.map((p) => p.orderRef));
  assert.equal(refs.size, 1);
  assert.equal([...refs][0], orden.orderRef);
  // Cada numero quedo apartado.
  assert.deepEqual(store.heldNumbers("t").held.sort((a, b) => a - b), [1, 2, 3]);
});

test("reserveMany es TODO-O-NADA: si un numero esta tomado, no aparta ninguno", () => {
  const store = createStore();
  nueva(store);
  store.reserve("t", 2, buyer, "MANUAL"); // 2 ya tomado

  assert.throws(() => store.reserveMany("t", [1, 2, 3], buyer, "WOMPI"), /Numero 2/);
  // 1 y 3 NO deben haber quedado apartados.
  assert.deepEqual(store.heldNumbers("t").held.sort((a, b) => a - b), [2]);
});

test("no deja pasar mas de MAX_NUMBERS_PER_ORDER ni numeros repetidos", () => {
  const store = createStore();
  nueva(store);
  const once = Array.from({ length: MAX_NUMBERS_PER_ORDER + 1 }, (_, i) => i);
  assert.throws(() => store.reserveMany("t", once, buyer, "WOMPI"), /Maximo/);
  assert.throws(() => store.reserveMany("t", [5, 5, 6], buyer, "WOMPI"), /repetidos/);
});

test("aprobar UNA compra de la orden vende TODOS sus numeros (un solo pago)", () => {
  const store = createStore();
  nueva(store);
  const orden = store.reserveMany("t", [10, 11, 12], buyer, "WOMPI");

  // Aprobar por el id de UNA de las compras aprueba toda la orden.
  store.approve(orden.purchases[0].id, { approvedBy: "admin@x.com" });

  const vendidos = store.publicNumbers("t").sold.map((s) => s.number).sort((a, b) => a - b);
  assert.deepEqual(vendidos, [10, 11, 12]);
  for (const p of orden.purchases) {
    assert.equal(store.getPurchase(p.id).status, "APPROVED");
  }
});

test("rechazar la orden libera TODOS sus numeros", () => {
  const store = createStore();
  nueva(store);
  const orden = store.reserveMany("t", [20, 21], buyer, "WOMPI");

  store.reject(orden.purchases[0].id, { reason: "pago no llego" });
  for (const p of orden.purchases) assert.equal(store.getPurchase(p.id).status, "REJECTED");
  // Vuelven a estar libres.
  const otra = store.reserveMany("t", [20, 21], buyer, "WOMPI");
  assert.equal(otra.count, 2);
});

test("el comprobante de la orden se adjunta a todos los numeros y los retiene", () => {
  const store = createStore({ reserveMinutes: -1 });
  nueva(store);
  const orden = store.reserveMany("t", [30, 31, 32], buyer, "MANUAL");

  store.attachReceiptToOrder(orden.orderRef, { bytes: PNG, mime: "image/png" });

  // Ninguno expira aunque la reserva este vencida: hay comprobante.
  assert.equal(store.expireReservations(), 0);
  for (const p of orden.purchases) {
    assert.equal(store.getPurchase(p.id).status, "PENDING");
    assert.ok(store.getReceipt(p.id).bytes, "cada numero de la orden tiene el comprobante");
  }
});

test("compat: reserve de 1 numero es una orden de tamaño 1", () => {
  const store = createStore();
  nueva(store);
  const p = store.reserve("t", 7, buyer, "MANUAL");
  assert.equal(p.orderRef, p.reference, "su orden es ella misma");
  store.approve(p.id, { approvedBy: "admin@x.com" });
  assert.equal(store.getPurchase(p.id).status, "APPROVED");
  assert.deepEqual(store.publicNumbers("t").sold.map((s) => s.number), [7]);
});
