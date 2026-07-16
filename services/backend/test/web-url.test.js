// URL publica de la web y createdAt (v1.9.0).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createStore } from "../src/store.js";
import { config } from "../src/config.js";
import { handler } from "../src/app.js";

async function pedir(server, path) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test("/health expone webPublicBase (para que el admin arme el enlace publico)", async (t) => {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const r = await pedir(server, "/health");
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.webPublicBase === "string" && r.body.webPublicBase.startsWith("https://"));
  // Sin barra final: se concatena `${base}/${slug}` sin dobles barras.
  assert.ok(!r.body.webPublicBase.endsWith("/"));
  assert.equal(r.body.webPublicBase, config.webPublicBase);
});

test("listRaffles devuelve createdAt (para ordenar por recientes)", () => {
  const store = createStore();
  store.createRaffle({
    slug: "t", title: "T", prize: "P", priceCents: 1000, currency: "COP",
    numberRange: { min: 0, max: 9 }, startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 864e5).toISOString(), minSoldToDraw: 0, status: "ACTIVE",
  });
  const r = store.listRaffles()[0];
  assert.ok(r.createdAt, "debe traer createdAt");
  assert.ok(!Number.isNaN(Date.parse(r.createdAt)), "createdAt es una fecha valida");
});
