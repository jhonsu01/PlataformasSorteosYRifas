// Vendedores (OPERATOR): asignacion de rifas, aprobacion con autoria y
// confirmaciones filtrables por vendedor/fecha (base del conteo y la exportacion).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createStore } from "../src/store.js";
import { handler } from "../src/app.js";

const nueva = (store, slug) =>
  store.createRaffle({
    slug, title: slug.toUpperCase(), prize: "P", priceCents: 1000000, currency: "COP",
    numberRange: { min: 0, max: 9 }, startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 864e5).toISOString(), minSoldToDraw: 0, status: "ACTIVE",
  });

function nuevoVendedor(store, { email = "v@x.com", fullName = "Maria Vende" } = {}) {
  return store.createAdmin({ email, passwordHash: "x", role: "OPERATOR", fullName });
}

test("createAdmin OPERATOR aparece en listSellers con su nombre y sin rifas", () => {
  const store = createStore();
  const v = nuevoVendedor(store);
  const sellers = store.listSellers();
  assert.equal(sellers.length, 1);
  assert.equal(sellers[0].id, v.id);
  assert.equal(sellers[0].fullName, "Maria Vende");
  assert.deepEqual(sellers[0].raffles, []);
});

test("asignar y revocar rifas no borra la cuenta", () => {
  const store = createStore();
  nueva(store, "a"); nueva(store, "b");
  const v = nuevoVendedor(store);

  store.assignSellerRaffles(v.id, ["a", "b"], "admin@x.com");
  assert.deepEqual(store.sellerRaffles(v.id).sort(), ["a", "b"]);
  assert.ok(store.sellerHasRaffle(v.id, "a"));

  store.revokeSellerRaffle(v.id, "a");
  assert.deepEqual(store.sellerRaffles(v.id), ["b"]);
  // La cuenta sigue viva.
  assert.equal(store.listSellers().length, 1);
  assert.ok(!store.sellerHasRaffle(v.id, "a"));
});

test("asignar una rifa inexistente falla (404)", () => {
  const store = createStore();
  const v = nuevoVendedor(store);
  assert.throws(() => store.assignSellerRaffles(v.id, ["fantasma"]), /no encontrada/i);
});

test("aprobar registra al vendedor que autorizo (id, nombre, rol)", () => {
  const store = createStore();
  nueva(store, "a");
  const v = nuevoVendedor(store, { email: "maria@x.com", fullName: "Maria Vende" });
  const p = store.reserve("a", 3, { firstName: "Ana", lastName: "Gomez", phone: "3001112233" }, "MANUAL");

  store.approve(p.id, {
    approvedBy: v.email, approverId: v.id, approverName: v.fullName, approverRole: v.role,
  });

  const listado = store.adminPurchases("a", "APPROVED");
  assert.equal(listado[0].approvedByName, "Maria Vende");
  assert.equal(listado[0].approvedByRole, "OPERATOR");
  assert.equal(listado[0].approvedById, v.id);
});

test("confirmationsBySeller filtra por vendedor y solo cuenta manuales aprobadas", () => {
  const store = createStore();
  nueva(store, "a");
  const v1 = nuevoVendedor(store, { email: "v1@x.com", fullName: "Uno" });
  const v2 = nuevoVendedor(store, { email: "v2@x.com", fullName: "Dos" });

  const p1 = store.reserve("a", 1, { firstName: "A", lastName: "A", phone: "3001110001" }, "MANUAL");
  const p2 = store.reserve("a", 2, { firstName: "B", lastName: "B", phone: "3001110002" }, "MANUAL");
  const p3 = store.reserve("a", 3, { firstName: "C", lastName: "C", phone: "3001110003" }, "MANUAL");

  store.approve(p1.id, { approvedBy: v1.email, approverId: v1.id, approverName: v1.fullName, approverRole: "OPERATOR" });
  store.approve(p2.id, { approvedBy: v1.email, approverId: v1.id, approverName: v1.fullName, approverRole: "OPERATOR" });
  store.approve(p3.id, { approvedBy: v2.email, approverId: v2.id, approverName: v2.fullName, approverRole: "OPERATOR" });

  const deV1 = store.confirmationsBySeller("a", { sellerId: v1.id });
  assert.equal(deV1.length, 2, "v1 confirmo 2 numeros");
  assert.deepEqual(deV1.map((i) => i.number).sort(), [1, 2]);

  const todas = store.confirmationsBySeller("a", {});
  assert.equal(todas.length, 3, "sin filtro de vendedor => todas las manuales aprobadas");
});

test("confirmationsBySeller respeta el rango de fechas", () => {
  const store = createStore();
  nueva(store, "a");
  const v = nuevoVendedor(store);
  const p = store.reserve("a", 4, { firstName: "A", lastName: "A", phone: "3001110004" }, "MANUAL");
  store.approve(p.id, { approvedBy: v.email, approverId: v.id, approverName: v.fullName, approverRole: "OPERATOR" });

  const futuro = new Date(Date.now() + 864e5).toISOString();
  const vacio = store.confirmationsBySeller("a", { sellerId: v.id, from: futuro });
  assert.equal(vacio.length, 0, "nada confirmado despues de manana");

  const pasado = new Date(Date.now() - 864e5).toISOString();
  const hay = store.confirmationsBySeller("a", { sellerId: v.id, from: pasado });
  assert.equal(hay.length, 1);
});

// --------------------------- Enrutado / permisos (handler) ---------------------------
function pedir(server, method, path, { token, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.address().port, method, path,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(data); } catch { return data; } })() }));
      }
    );
    if (body && method !== "GET") req.write(JSON.stringify(body));
    req.end();
  });
}

test("los endpoints de vendedores exigen autenticacion", async (t) => {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());

  const protegidos = [
    ["GET", "/api/admin/sellers"],
    ["POST", "/api/admin/sellers"],
    ["POST", "/api/admin/sellers/abc/raffles"],
    ["DELETE", "/api/admin/sellers/abc/raffles/xyz"],
    ["GET", "/api/admin/confirmations?slug=sorteo-demo"],
    ["GET", "/api/seller/raffles"],
  ];
  for (const [m, p] of protegidos) {
    // Sin body: un DELETE/GET con cuerpo hace que Node responda 400 antes del handler.
    const r = await pedir(server, m, p, m === "POST" ? { body: {} } : {});
    assert.equal(r.status, 401, `${m} ${p} deberia exigir autenticacion`);
  }
});
