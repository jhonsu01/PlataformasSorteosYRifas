// Ciudad del comprador: dato PUBLICO (el organizador quiere saber desde donde
// le compran). Se prueba que sale al estado publico, que es opcional y que no
// se cuela una direccion completa.

import test from "node:test";
import assert from "node:assert/strict";
import { createStore, normalizeCity } from "../src/store.js";

const demo = (store) =>
  store.createRaffle({
    slug: "t", title: "T", prize: "P", priceCents: 1000, currency: "COP",
    numberRange: { min: 0, max: 9 }, startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 864e5).toISOString(), minSoldToDraw: 0, status: "ACTIVE",
  });

test("la ciudad sale al estado publico junto al seudonimo", () => {
  const store = createStore();
  demo(store);
  const p = store.reserve("t", 3, { firstName: "Juan", lastName: "Restrepo", city: "Medellín" }, "MANUAL");
  store.approve(p.id);
  const sold = store.publicNumbers("t").sold[0];
  assert.equal(sold.buyer, "Juan R.");
  assert.equal(sold.city, "Medellín");
});

test("sin ciudad, la clave se omite (no null en el JSON publico)", () => {
  const store = createStore();
  demo(store);
  const p = store.reserve("t", 4, { firstName: "Ana", lastName: "Gomez" }, "MANUAL");
  store.approve(p.id);
  const sold = store.publicNumbers("t").sold[0];
  assert.ok(!("city" in sold), "no debe aparecer la clave city si no la dieron");
});

test("normalizeCity recorta y colapsa espacios; no deja meter una direccion larga", () => {
  assert.equal(normalizeCity("  Medellín  "), "Medellín");
  assert.equal(normalizeCity("Bogota   D.C."), "Bogota D.C.");
  assert.equal(normalizeCity(""), null);
  assert.equal(normalizeCity(null), null);
  const larga = "Calle 123 # 45-67 apto 890 barrio tal ciudad cual departamento equis pais zeta y mas";
  assert.equal(normalizeCity(larga).length, 60, "se recorta a 60 (una direccion no cabe entera)");
});

test("la ciudad tambien llega al admin (adminPurchases)", () => {
  const store = createStore();
  demo(store);
  const p = store.reserve("t", 5, { firstName: "Ana", lastName: "Gomez", city: "Cali", phone: "3001112233" }, "MANUAL");
  const fila = store.adminPurchases("t", "PENDING")[0];
  assert.equal(fila.city, "Cali");
  assert.equal(fila.contact.phone, "3001112233");
});
