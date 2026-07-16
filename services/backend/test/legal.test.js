// Responsable de la rifa: transparencia legal.
//
// Es de los pocos datos que SI se publican y que ademas puede llevar el nombre
// de una persona real. Se prueba que se publica bien, que no rompe rifas viejas
// y que los campos de texto/URL no abren un hueco de XSS.

import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { normalizeOrganizer, REGIMENES } from "../src/legal.js";

const demoRaffle = (store, extra = {}) =>
  store.createRaffle({
    slug: "t", title: "T", prize: "P", priceCents: 1000, currency: "COP",
    numberRange: { min: 0, max: 9 }, startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 864e5).toISOString(), minSoldToDraw: 0, status: "ACTIVE",
    ...extra,
  });

test("el responsable SI se publica en raffle.json (es rendicion de cuentas)", () => {
  const store = createStore();
  demoRaffle(store, {
    organizer: {
      name: "Jhon S.",
      regime: "REGULADA",
      authorization: "Permiso 123 expedido por la autoridad de juegos",
      documents: ["https://ejemplo.org/permiso.pdf"],
    },
  });
  const r = store.publicRaffle("t");
  assert.equal(r.organizer.name, "Jhon S.");
  assert.equal(r.organizer.regime, "REGULADA");
  assert.equal(r.organizer.authorization, "Permiso 123 expedido por la autoridad de juegos");
  assert.deepEqual(r.organizer.documents, ["https://ejemplo.org/permiso.pdf"]);
});

test("una rifa sin responsable sigue funcionando (rifas anteriores a v1.8.0)", () => {
  const store = createStore();
  demoRaffle(store);
  assert.deepEqual(store.publicRaffle("t").organizer, {});
});

test("con solo el nombre, el regimen cae en DESCENTRALIZADA", () => {
  const store = createStore();
  demoRaffle(store, { organizer: { name: "Comité del barrio" } });
  const o = store.publicRaffle("t").organizer;
  assert.equal(o.name, "Comité del barrio");
  assert.equal(o.regime, "DESCENTRALIZADA", "el default honesto: no afirma estar regulada");
});

test("el regimen solo acepta los valores validos", () => {
  assert.equal(normalizeOrganizer({ name: "A", regime: "regulada" }).regime, "REGULADA");
  assert.throws(() => normalizeOrganizer({ name: "A", regime: "OFICIAL" }), /REGULADA o DESCENTRALIZADA|DESCENTRALIZADA o REGULADA/);
  assert.deepEqual(REGIMENES, ["DESCENTRALIZADA", "REGULADA"]);
});

test("los documentos solo aceptan https: bloquea javascript: y data:", () => {
  assert.throws(() => normalizeOrganizer({ name: "A", documents: ["javascript:alert(1)"] }), /https/);
  assert.throws(() => normalizeOrganizer({ name: "A", documents: ["http://inseguro/x.pdf"] }), /https/);
  const ok = normalizeOrganizer({ name: "A", documents: ["https://x.org/a.pdf", ""] });
  assert.deepEqual(ok.documents, ["https://x.org/a.pdf"]);
});

test("hay tope de documentos y de longitud de texto", () => {
  const muchos = Array.from({ length: 7 }, (_, i) => `https://x.org/${i}.pdf`);
  assert.throws(() => normalizeOrganizer({ name: "A", documents: muchos }), /maximo/);
  assert.throws(() => normalizeOrganizer({ name: "A".repeat(121) }), /maximo/);
});

test("un objeto vacio es valido (no todo el mundo pone responsable)", () => {
  assert.deepEqual(normalizeOrganizer({}), {});
  assert.deepEqual(normalizeOrganizer(null), {});
  assert.throws(() => normalizeOrganizer([]), /objeto/);
  assert.throws(() => normalizeOrganizer("Jhon"), /objeto/);
});

test("el responsable se puede editar despues (updateRaffle)", () => {
  const store = createStore();
  demoRaffle(store);
  store.updateRaffle("t", { organizer: { name: "Nuevo responsable", regime: "REGULADA" } });
  assert.equal(store.publicRaffle("t").organizer.name, "Nuevo responsable");
  // Mandar solo el tema no borra el responsable.
  store.updateRaffle("t", { theme: { accent: "#f5c518" } });
  assert.equal(store.publicRaffle("t").organizer.name, "Nuevo responsable");
});
