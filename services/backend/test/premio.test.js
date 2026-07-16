// Premio mostrable: fotos, video, desglose con valores y tema.
//
// El foco esta en lo que puede MENTIRLE AL COMPRADOR (el valor del premio) y en
// lo que puede publicarse sin querer (privacidad, CSS/XSS por campos de texto).

import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import {
  normalizePrizeItems, normalizeMedia, normalizeTheme, normalizeAccent,
  youtubeId, prizeTotalCents, LIMITES,
} from "../src/raffle-media.js";

const demoRaffle = (store, extra = {}) =>
  store.createRaffle({
    slug: "t", title: "T", prize: "P", priceCents: 1000, currency: "COP",
    numberRange: { min: 0, max: 9 }, startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 864e5).toISOString(), minSoldToDraw: 0, status: "ACTIVE",
    ...extra,
  });

// --------------------------- Valor del premio ---------------------------

test("el total del premio es la SUMA de los items, no un campo aparte", () => {
  const store = createStore();
  demoRaffle(store, {
    prizeItems: [
      { name: "Microscopio", valueCents: 130000000 },
      { name: "Cámara 4K", valueCents: 48000000 },
      { name: "Fuente", valueCents: 75000000 },
    ],
  });
  const r = store.publicRaffle("t");
  assert.equal(r.prizeTotalCents, 253000000);
});

test("el total se recalcula al editar: NO puede quedar desincronizado", () => {
  const store = createStore();
  demoRaffle(store, { prizeItems: [{ name: "A", valueCents: 100 }] });
  assert.equal(store.publicRaffle("t").prizeTotalCents, 100);

  store.updateRaffle("t", { prizeItems: [{ name: "A", valueCents: 100 }, { name: "B", valueCents: 250 }] });
  assert.equal(store.publicRaffle("t").prizeTotalCents, 350, "debe reflejar el nuevo desglose");

  store.updateRaffle("t", { prizeItems: [] });
  assert.equal(store.publicRaffle("t").prizeTotalCents, 0, "sin items, el total es 0");
});

test("un premio de una sola cosa funciona igual que uno de muchas", () => {
  const store = createStore();
  demoRaffle(store, { prizeItems: [{ name: "Moto 0km", valueCents: 1200000000 }] });
  const r = store.publicRaffle("t");
  assert.equal(r.prizeItems.length, 1);
  assert.equal(r.prizeTotalCents, 1200000000);
});

test("el valor es dinero: rechaza decimales, negativos y basura", () => {
  // Centavos con decimales serian pesos fraccionados que nadie puede pagar.
  assert.throws(() => normalizePrizeItems([{ name: "A", valueCents: 100.5 }]), /entero/);
  assert.throws(() => normalizePrizeItems([{ name: "A", valueCents: -1 }]), /entero/);
  assert.throws(() => normalizePrizeItems([{ name: "A", valueCents: "mucho" }]), /entero/);
  assert.throws(() => normalizePrizeItems([{ name: "A", valueCents: Infinity }]), /entero/);
  assert.throws(() => normalizePrizeItems([{ name: "A", valueCents: NaN }]), /entero/);
  // Un premio de 10 billones de pesos es un dedo de mas, no una rifa.
  assert.throws(() => normalizePrizeItems([{ name: "A", valueCents: LIMITES.valorCents + 1 }]), /rango/);
});

test("un item sin nombre no entra: seria una linea vacia con precio", () => {
  assert.throws(() => normalizePrizeItems([{ name: "  ", valueCents: 100 }]), /requerido/);
});

test("prizeTotalCents suma sin desbordar con valores grandes y muchos items", () => {
  const items = Array.from({ length: 60 }, () => ({ valueCents: 999_999_999_999 }));
  // 60 * ~1e12 = 6e13, muy por debajo de Number.MAX_SAFE_INTEGER (9e15).
  assert.equal(prizeTotalCents(items), 59_999_999_999_940);
  assert.ok(prizeTotalCents(items) < Number.MAX_SAFE_INTEGER);
});

test("hay tope de items y de fotos", () => {
  const muchos = Array.from({ length: LIMITES.items + 1 }, (_, i) => ({ name: `i${i}`, valueCents: 0 }));
  assert.throws(() => normalizePrizeItems(muchos), /maximo/);
  const fotos = Array.from({ length: LIMITES.galeria + 1 }, () => "https://x.com/a.jpg");
  assert.throws(() => normalizeMedia({ gallery: fotos }), /maximo/);
});

// --------------------------- Seguridad de los campos ---------------------------

test("el acento solo acepta hex: es CSS escrito desde la base de datos", () => {
  assert.equal(normalizeAccent("#f5c518"), "#f5c518");
  assert.equal(normalizeAccent("#ABC"), "#abc");
  // Si esto pasara, la web escribiria CSS arbitrario en su variable de color.
  assert.throws(() => normalizeAccent("red; background: url(http://malo/x)"), /hex/);
  assert.throws(() => normalizeAccent("javascript:alert(1)"), /hex/);
  assert.throws(() => normalizeAccent("rgb(1,2,3)"), /hex/);
  assert.equal(normalizeAccent(""), "", "vacio = usar el color por defecto");
});

test("las imagenes solo aceptan https: bloquea javascript: y data:", () => {
  assert.throws(() => normalizeMedia({ cover: "javascript:alert(1)" }), /https/);
  assert.throws(() => normalizeMedia({ cover: "data:text/html,<script>alert(1)</script>" }), /https/);
  assert.throws(() => normalizeMedia({ cover: "http://inseguro.com/a.jpg" }), /https/);
  assert.throws(() => normalizePrizeItems([{ name: "A", imageUrl: "javascript:alert(1)" }]), /https/);
  const ok = normalizeMedia({ cover: "https://raw.githubusercontent.com/o/r/main/public/media/ab.jpg" });
  assert.ok(ok.cover.startsWith("https://"));
});

test("el JSON publico del premio no filtra datos privados", () => {
  const store = createStore();
  demoRaffle(store, { prizeItems: [{ name: "Moto", valueCents: 100 }] });
  const p = store.reserve("t", 3, { firstName: "Ana", lastName: "Gomez", phone: "3001234567" });
  store.approve(p.id);

  const publico = JSON.stringify(store.publicRaffle("t"));
  for (const secreto of ["3001234567", "Gomez", "phone", "private"]) {
    assert.ok(!publico.includes(secreto), `raffle.json no debe contener "${secreto}"`);
  }
});

// --------------------------- YouTube ---------------------------

test("acepta las formas reales de una URL de YouTube y guarda solo el id", () => {
  const id = "dQw4w9WgXcQ";
  const formas = [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&list=PL123&t=42`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?t=30`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    id,
  ];
  for (const f of formas) assert.equal(youtubeId(f), id, `fallo con: ${f}`);
});

test("rechaza lo que no es YouTube en vez de embeber cualquier cosa", () => {
  assert.throws(() => youtubeId("https://vimeo.com/12345"), /YouTube/);
  assert.throws(() => youtubeId("https://www.youtube.com/watch?v=corto"), /YouTube/);
  assert.throws(() => youtubeId("no es una url"), /invalida|YouTube/);
  assert.equal(youtubeId(""), "", "vacio = sin video");
});

// --------------------------- Estado de publicacion ---------------------------

test("una rifa nace SIN publicar y markPublished lo registra", () => {
  const store = createStore();
  demoRaffle(store);
  // El bug original: el admin no podia distinguir estos dos estados y mostraba
  // "Publicar a GitHub" para siempre.
  assert.equal(store.listRaffles()[0].publishedAt, null);

  store.markPublished("t", "org/t");
  const r = store.listRaffles()[0];
  assert.ok(r.publishedAt, "debe quedar la marca de tiempo");
  assert.equal(r.repoFullName, "org/t");
});

test("listRaffles trae lo que el admin necesita pintar la tarjeta", () => {
  const store = createStore();
  demoRaffle(store, {
    media: { cover: "https://x.com/c.jpg" },
    prizeItems: [{ name: "A", valueCents: 500 }],
  });
  const r = store.listRaffles()[0];
  assert.equal(r.cover, "https://x.com/c.jpg");
  assert.equal(r.prizeTotalCents, 500);
});

// --------------------------- updateRaffle ---------------------------

test("updateRaffle solo toca lo que se manda", () => {
  const store = createStore();
  demoRaffle(store, { prizeItems: [{ name: "A", valueCents: 100 }] });
  store.updateRaffle("t", { theme: { accent: "#f5c518" } });
  const r = store.publicRaffle("t");
  // Mandar solo el tema no puede borrar el premio.
  assert.equal(r.prizeItems.length, 1, "los items siguen ahi");
  assert.equal(r.theme.accent, "#f5c518");
});

test("updateRaffle NO deja cambiar el rango de numeros", () => {
  const store = createStore();
  demoRaffle(store);
  store.reserve("t", 5, { firstName: "Ana", lastName: "Gomez" });
  store.updateRaffle("t", { numberRange: { min: 0, max: 3 } });
  // Si lo aceptara, la compra del 5 quedaria apuntando fuera de rango.
  assert.equal(store.publicRaffle("t").numberRange.max, 9);
});

test("media: guarda el id del video, no la URL con tracking", () => {
  const store = createStore();
  demoRaffle(store);
  store.updateRaffle("t", {
    media: { youtubeId: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxx&si=track" },
  });
  assert.equal(store.publicRaffle("t").media.youtubeId, "dQw4w9WgXcQ");
});

test("normalizeTheme y normalizeMedia rechazan tipos que no son objeto", () => {
  assert.throws(() => normalizeTheme([]), /objeto/);
  assert.throws(() => normalizeTheme("azul"), /objeto/);
  assert.throws(() => normalizeMedia([]), /objeto/);
  assert.throws(() => normalizeMedia({ gallery: "una foto" }), /lista/);
  assert.throws(() => normalizePrizeItems({ name: "A" }), /lista/);
  assert.throws(() => normalizePrizeItems(["texto suelto"]), /objeto/);
});
