// Pruebas del publicador a GitHub con `fetch` simulado: verifican las llamadas
// exactas a la API (crear repo, sha para actualizar, base64, privacidad) sin
// tocar ninguna cuenta real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";

process.env.GITHUB_TOKEN = "token-de-prueba";
process.env.GITHUB_RIFFLES_OWNER = "dueno-prueba";
const { publishPublicState } = await import("../src/publisher.js");
const { config } = await import("../src/config.js");

const RAFFLE = {
  slug: "rifa-x", title: "Rifa X", prize: "Premio X", priceCents: 1000000,
  currency: "COP", numberRange: { min: 0, max: 9 },
  startsAt: "2026-07-15T00:00:00-05:00", endsAt: "2026-08-15T00:00:00-05:00",
  minSoldToDraw: 1, status: "ACTIVE",
};

async function storeConVenta() {
  const store = createStore();
  await store.createRaffle(RAFFLE);
  const p = await store.reserve("rifa-x", 3, {
    firstName: "Ana", lastName: "Gomez", phone: "3001234567", email: "ana@correo.com",
  });
  await store.approve(p.id, { approvedBy: "test" });
  return store;
}

/** Simula la API de GitHub y registra cada llamada. */
function mockGitHub({ repoExiste = true, ownerType = "User", fallaCrear = false } = {}) {
  const llamadas = [];
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace("https://api.github.com", "");
    const method = opts.method || "GET";
    llamadas.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null });

    const ok = (obj, status = 200) => new Response(JSON.stringify(obj), { status });

    if (path.startsWith("/users/")) return ok({ type: ownerType });
    if (method === "GET" && path.includes("/contents/")) {
      return repoExiste ? ok({ sha: "sha-actual" }) : ok({ message: "Not Found" }, 404);
    }
    if (method === "PUT" && path.includes("/contents/")) return ok({ commit: { sha: "commit-nuevo" } });
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(path)) {
      return repoExiste ? ok({ name: "rifa-x" }) : ok({ message: "Not Found" }, 404);
    }
    if (method === "POST" && (path === "/user/repos" || path.startsWith("/orgs/"))) {
      return fallaCrear ? ok({ message: "Resource not accessible by personal access token" }, 403)
                        : ok({ name: "rifa-x" }, 201);
    }
    return ok({ message: "no manejado: " + method + " " + path }, 500);
  };
  return llamadas;
}

test("sin token/owner no publica (modo demo) y no llama a GitHub", async () => {
  // `config` es un singleton: se muta y se restaura (re-importar no lo recarga).
  const original = globalThis.fetch;
  const prev = config.github.token;
  globalThis.fetch = async () => { throw new Error("no deberia llamar a GitHub en modo demo"); };
  config.github.token = "";
  try {
    const store = await storeConVenta();
    const r = await publishPublicState(store, "rifa-x");
    assert.equal(r.published, false);
    assert.match(r.reason, /no configurado/i);
  } finally {
    config.github.token = prev;
    globalThis.fetch = original;
  }
});

test("si el repo ya existe: NO lo crea y actualiza con el sha actual", async () => {
  const llamadas = mockGitHub({ repoExiste: true });
  const store = await storeConVenta();
  const r = await publishPublicState(store, "rifa-x");

  assert.equal(r.published, true);
  assert.equal(r.created, false);
  assert.ok(!llamadas.some((c) => c.method === "POST"), "no debe crear el repo");

  const puts = llamadas.filter((c) => c.method === "PUT");
  assert.deepEqual(puts.map((c) => c.path.split("/contents/")[1].split("?")[0]).sort(),
    ["public/numbers.json", "public/raffle.json"]);
  // Actualizar exige mandar el sha del archivo actual.
  assert.ok(puts.every((c) => c.body.sha === "sha-actual"), "debe enviar el sha para actualizar");
});

test("si el repo no existe: lo crea (cuenta personal) y escribe el README", async () => {
  const llamadas = mockGitHub({ repoExiste: false, ownerType: "User" });
  const store = await storeConVenta();
  const r = await publishPublicState(store, "rifa-x");

  assert.equal(r.published, true);
  assert.equal(r.created, true);
  const crear = llamadas.find((c) => c.method === "POST");
  assert.equal(crear.path, "/user/repos", "cuenta personal -> /user/repos");
  assert.equal(crear.body.name, "rifa-x");
  assert.equal(crear.body.private, false, "el repo debe ser publico: es el punto de la auditabilidad");
  assert.equal(crear.body.auto_init, true);
  assert.ok(llamadas.some((c) => c.method === "PUT" && c.path.includes("README.md")));
  // Al crear no hay sha previo.
  const putRaffle = llamadas.find((c) => c.method === "PUT" && c.path.includes("raffle.json"));
  assert.equal(putRaffle.body.sha, undefined);
});

test("si el owner es una organizacion usa /orgs/<owner>/repos", async () => {
  const llamadas = mockGitHub({ repoExiste: false, ownerType: "Organization" });
  const store = await storeConVenta();
  await publishPublicState(store, "rifa-x");
  assert.equal(llamadas.find((c) => c.method === "POST").path, "/orgs/dueno-prueba/repos");
});

test("el contenido publicado va en base64 y NO lleva datos privados", async () => {
  const llamadas = mockGitHub({ repoExiste: true });
  const store = await storeConVenta();
  await publishPublicState(store, "rifa-x");

  const put = llamadas.find((c) => c.method === "PUT" && c.path.includes("numbers.json"));
  const json = JSON.parse(Buffer.from(put.body.content, "base64").toString("utf8"));
  assert.equal(json.sold[0].buyer, "Ana G.");
  assert.deepEqual(Object.keys(json.sold[0]).sort(), ["buyer", "number", "purchasedAt", "verifiedAt"]);

  const crudo = Buffer.from(put.body.content, "base64").toString("utf8");
  for (const secreto of ["3001234567", "ana@correo.com", "Gomez"]) {
    assert.ok(!crudo.includes(secreto), `fuga de dato privado: ${secreto}`);
  }
});

test("al declarar ganador tambien publica draw.json", async () => {
  const llamadas = mockGitHub({ repoExiste: true });
  const store = await storeConVenta();
  const draw = await store.declareWinner("rifa-x", 3, "ADMIN_INPUT");
  await publishPublicState(store, "rifa-x", { draw });
  const put = llamadas.find((c) => c.method === "PUT" && c.path.includes("draw.json"));
  assert.ok(put, "debe publicar draw.json");
  const json = JSON.parse(Buffer.from(put.body.content, "base64").toString("utf8"));
  assert.equal(json.winningNumber, 3);
  assert.equal(json.winner.buyer, "Ana G.");
});

test("si no puede crear el repo, explica que se cree a mano y NO lanza", async () => {
  mockGitHub({ repoExiste: false, fallaCrear: true });
  const store = await storeConVenta();
  // Publicar es un efecto secundario: nunca debe tumbar una venta ya cobrada.
  const r = await publishPublicState(store, "rifa-x");
  assert.equal(r.published, false);
  assert.match(r.reason, /a mano|403/i, `mensaje poco util: ${r.reason}`);
});
