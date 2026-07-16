// "Mis números" por teléfono: recuperar las compras de un teléfono en una rifa.
//
// Es un endpoint de BÚSQUEDA sobre datos que pueden ser de terceros, así que el
// foco de las pruebas es la privacidad: que devuelva lo justo y nada más.

import test from "node:test";
import assert from "node:assert/strict";
import { createStore, normalizePhone } from "../src/store.js";

const demo = (store) =>
  store.createRaffle({
    slug: "t", title: "T", prize: "P", priceCents: 1000, currency: "COP",
    numberRange: { min: 0, max: 20 }, startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 864e5).toISOString(), minSoldToDraw: 0, status: "ACTIVE",
  });

test("devuelve solo los números de ESE teléfono", () => {
  const store = createStore();
  demo(store);
  const a = store.reserve("t", 3, { firstName: "Ana", lastName: "Gomez", phone: "300 111 2233" }, "MANUAL");
  store.approve(a.id);
  store.reserve("t", 5, { firstName: "Ana", lastName: "Gomez", phone: "3001112233" }, "MANUAL"); // mismo tel, PENDING
  store.reserve("t", 7, { firstName: "Otro", lastName: "Distinto", phone: "3009998877" }, "MANUAL");

  // Se compara por los últimos 10 dígitos: espacios, guiones y el +57 no importan.
  const mias = store.purchasesByPhone("t", "+57 300-111-2233");
  assert.deepEqual(mias.map((m) => m.number), [3, 5]);
  assert.equal(mias.find((m) => m.number === 3).status, "APPROVED");
  assert.equal(mias.find((m) => m.number === 5).status, "PENDING");
});

test("NO devuelve nombre ni ciudad (aunque adivinen el teléfono, no cosechan datos)", () => {
  const store = createStore();
  demo(store);
  const p = store.reserve("t", 4, { firstName: "Ana", lastName: "Gomez", phone: "3001112233", city: "Cali" }, "MANUAL");
  store.approve(p.id);
  const mias = store.purchasesByPhone("t", "3001112233");
  const txt = JSON.stringify(mias);
  for (const secreto of ["Ana", "Gomez", "Cali", "buyer", "city", "private"]) {
    assert.ok(!txt.includes(secreto), `no debe devolver "${secreto}"`);
  }
  // Sí devuelve lo justo para seguir la compra.
  assert.deepEqual(Object.keys(mias[0]).sort(), ["hasReceipt", "method", "number", "purchaseId", "status", "verifiedAt"]);
});

test("ignora las rechazadas (el número ya se liberó)", () => {
  const store = createStore();
  demo(store);
  const p = store.reserve("t", 6, { firstName: "Ana", lastName: "Gomez", phone: "3001112233" }, "MANUAL");
  store.reject(p.id, { reason: "no pagó" });
  assert.deepEqual(store.purchasesByPhone("t", "3001112233"), []);
});

test("un teléfono corto/incompleto no devuelve nada (evita barrer con '1')", () => {
  const store = createStore();
  demo(store);
  const p = store.reserve("t", 8, { firstName: "Ana", lastName: "Gomez", phone: "3001112233" }, "MANUAL");
  store.approve(p.id);
  assert.deepEqual(store.purchasesByPhone("t", "300"), []);
  assert.deepEqual(store.purchasesByPhone("t", ""), []);
});

test("normalizePhone deja solo dígitos", () => {
  assert.equal(normalizePhone("+57 300 111-2233"), "573001112233");
  assert.equal(normalizePhone("300.111.2233"), "3001112233");
  assert.equal(normalizePhone(null), "");
});
