// Pago manual: medios de pago, comprobante y retencion del numero.
//
// El caso que mas duele: alguien paga por Nequi, sube el pantallazo y espera.
// Si el sistema le suelta el numero mientras espera, perdio la plata y el numero
// se puede vender otra vez. Eso es lo que blindan las primeras pruebas.

import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { normalizePaymentMethods } from "../src/payments.js";

const demoRaffle = (store, extra = {}) =>
  store.createRaffle({
    slug: "t", title: "T", prize: "P", priceCents: 2000000, currency: "COP",
    numberRange: { min: 0, max: 9 }, startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 864e5).toISOString(), minSoldToDraw: 0, status: "ACTIVE",
    ...extra,
  });

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

// --------------------------- Retencion del numero ---------------------------

test("CRITICO: una compra CON comprobante no expira aunque venza la reserva", () => {
  // reserveMinutes NEGATIVO => la reserva nace vencida hace un minuto. Con 0
  // nacia vencida "ahora mismo" y `reservedUntil < now` era falso en el mismo
  // milisegundo: la prueba pasaba por casualidad, no por la guarda.
  const store = createStore({ reserveMinutes: -1 });
  demoRaffle(store);
  const p = store.reserve("t", 4, { firstName: "Ana", lastName: "Gomez" }, "MANUAL");
  store.attachReceipt(p.id, { bytes: PNG, mime: "image/png" });

  const liberados = store.expireReservations();

  assert.equal(liberados, 0, "no debe liberar un numero cuyo pago ya se envio");
  assert.equal(store.getPurchase(p.id).status, "PENDING", "sigue esperando al admin");
  // Y el numero sigue tomado: nadie mas puede comprarlo.
  assert.throws(() => store.reserve("t", 4, { firstName: "Otro", lastName: "Vivo" }), /no disponible/);
});

test("una compra SIN comprobante si expira y libera el numero", () => {
  const store = createStore({ reserveMinutes: -1 });
  demoRaffle(store);
  const p = store.reserve("t", 5, { firstName: "Ana", lastName: "Gomez" }, "MANUAL");

  assert.equal(store.expireReservations(), 1);
  assert.equal(store.getPurchase(p.id).status, "REJECTED");
  // El numero vuelve al mercado.
  const p2 = store.reserve("t", 5, { firstName: "Otro", lastName: "Comprador" });
  assert.equal(p2.number, 5);
});

test("el comprobante solo sale de PENDING cuando decide un humano", () => {
  const store = createStore({ reserveMinutes: -1 });
  demoRaffle(store);
  const p = store.reserve("t", 6, { firstName: "Ana", lastName: "Gomez" }, "MANUAL");
  store.attachReceipt(p.id, { bytes: PNG, mime: "image/png" });

  // Por muchas veces que corra el cron, no lo toca.
  for (let i = 0; i < 5; i++) store.expireReservations();
  assert.equal(store.getPurchase(p.id).status, "PENDING");

  store.approve(p.id, { approvedBy: "admin@x.com" });
  assert.equal(store.getPurchase(p.id).status, "APPROVED");
  assert.equal(store.publicNumbers("t").sold.length, 1);
});

test("rechazar una compra con comprobante SI libera el numero", () => {
  const store = createStore();
  demoRaffle(store);
  const p = store.reserve("t", 7, { firstName: "Ana", lastName: "Gomez" }, "MANUAL");
  store.attachReceipt(p.id, { bytes: PNG, mime: "image/png" });
  store.reject(p.id, { reason: "El pantallazo no corresponde" });

  assert.equal(store.getPurchase(p.id).status, "REJECTED");
  const p2 = store.reserve("t", 7, { firstName: "Otro", lastName: "Comprador" });
  assert.equal(p2.number, 7, "el numero vuelve a estar libre");
});

// --------------------------- Privacidad del comprobante ---------------------------

test("el comprobante NUNCA sale al estado publico", () => {
  const store = createStore();
  demoRaffle(store);
  const p = store.reserve("t", 3, { firstName: "Ana", lastName: "Gomez", phone: "3001234567" }, "MANUAL");
  store.attachReceipt(p.id, { bytes: PNG, mime: "image/png" });
  store.approve(p.id);

  // Un pantallazo de Nequi lleva nombre completo, banco y a veces el saldo.
  const publico = JSON.stringify(store.publicNumbers("t")) + JSON.stringify(store.publicRaffle("t"));
  for (const secreto of ["receipt", "image/png", "3001234567", "Gomez"]) {
    assert.ok(!publico.includes(secreto), `el estado publico no debe contener "${secreto}"`);
  }
});

test("los medios de pago no viajan al JSON publico (el repo es inmutable)", () => {
  const store = createStore();
  demoRaffle(store, {
    paymentMethods: [{ label: "Nequi", value: "3200000000" }],
  });
  // Un numero de cuenta commiteado a GitHub queda en el historial para siempre.
  const publico = JSON.stringify(store.publicRaffle("t"));
  assert.ok(!publico.includes("3200000000"), "no debe publicar la cuenta");
  assert.ok(!publico.includes("Nequi"), "no debe publicar el medio de pago");
  // Pero el backend si los sirve a quien va a comprar.
  assert.equal(store.paymentInfo("t").paymentMethods[0].value, "3200000000");
});

// --------------------------- Medios de pago ---------------------------

test("normaliza los medios de pago y exige etiqueta y dato", () => {
  const m = normalizePaymentMethods([
    { label: " Nequi ", value: " 3200000000 ", hint: " A nombre de Jhon S. " },
  ]);
  assert.deepEqual(m, [{ label: "Nequi", value: "3200000000", hint: "A nombre de Jhon S." }]);

  assert.throws(() => normalizePaymentMethods([{ label: "", value: "123" }]), /label/);
  assert.throws(() => normalizePaymentMethods([{ label: "Nequi", value: "" }]), /value/);
  assert.throws(() => normalizePaymentMethods("Nequi"), /lista/);
  assert.throws(() => normalizePaymentMethods([{ label: "A".repeat(41), value: "1" }]), /maximo/);
});

// --------------------------- Interruptores de metodo ---------------------------

test("si la pasarela esta apagada, no se puede reservar con WOMPI", () => {
  const store = createStore();
  demoRaffle(store, { gatewayEnabled: false });
  assert.throws(
    () => store.reserve("t", 1, { firstName: "Ana", lastName: "Gomez" }, "WOMPI"),
    /pasarela/i,
  );
  // El manual sigue abierto.
  const p = store.reserve("t", 1, { firstName: "Ana", lastName: "Gomez" }, "MANUAL");
  assert.equal(p.method, "MANUAL");
});

test("si los pagos manuales estan apagados, no se puede reservar con MANUAL", () => {
  const store = createStore();
  demoRaffle(store, { manualEnabled: false });
  assert.throws(
    () => store.reserve("t", 2, { firstName: "Ana", lastName: "Gomez" }, "MANUAL"),
    /manual/i,
  );
  const p = store.reserve("t", 2, { firstName: "Ana", lastName: "Gomez" }, "WOMPI");
  assert.equal(p.method, "WOMPI");
});

test("paymentInfo dice que medios acepta la rifa", () => {
  const store = createStore();
  demoRaffle(store, {
    gatewayEnabled: false,
    paymentMethods: [{ label: "Nequi", value: "3200000000" }],
  });
  const info = store.paymentInfo("t");
  assert.equal(info.gatewayEnabled, false);
  assert.equal(info.manualEnabled, true);
  assert.equal(info.paymentMethods.length, 1);
});

// --------------------------- Fecha del sorteo ---------------------------

test("la fecha del sorteo no puede ser ANTES del cierre de ventas", () => {
  const store = createStore();
  const ends = new Date(Date.now() + 10 * 864e5).toISOString();
  assert.throws(
    () => store.createRaffle({
      slug: "x", title: "X", prize: "P", priceCents: 1000, currency: "COP",
      numberRange: { min: 0, max: 9 }, startsAt: new Date().toISOString(),
      endsAt: ends, drawAt: new Date(Date.now() + 5 * 864e5).toISOString(),
      minSoldToDraw: 0, status: "ACTIVE",
    }),
    /antes/i,
  );
});

test("la fecha del sorteo se publica y se puede posponer", () => {
  const store = createStore();
  const ends = new Date(Date.now() + 10 * 864e5).toISOString();
  const draw = new Date(Date.now() + 14 * 864e5).toISOString();
  demoRaffle(store, { endsAt: ends, drawAt: draw });
  assert.equal(store.publicRaffle("t").drawAt, draw);

  // No se vendio el minimo -> se aplaza. Es la regla de postergacion de la Guia.
  const nuevo = new Date(Date.now() + 30 * 864e5).toISOString();
  store.updateRaffle("t", { drawAt: nuevo });
  assert.equal(store.publicRaffle("t").drawAt, nuevo);
});
