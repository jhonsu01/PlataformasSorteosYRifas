import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createStore } from "../src/store.js";
import { enforceRateLimit, clientIp } from "../src/rate-limit.js";

function req(headers = {}) {
  return { headers, socket: { remoteAddress: "10.0.0.1" } };
}

test("clientIp: prefiere x-forwarded-for (proxy de Vercel)", () => {
  assert.equal(clientIp(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })), "1.2.3.4");
  assert.equal(clientIp(req({ "x-real-ip": "9.9.9.9" })), "9.9.9.9");
  assert.equal(clientIp(req()), "10.0.0.1", "cae al socket si no hay cabeceras");
});

test("permite hasta el limite y bloquea con 429 al pasarse", async () => {
  const store = createStore();
  const r = req({ "x-forwarded-for": "1.1.1.1" });
  const opts = { name: "prueba", limit: 3, windowSec: 60 };

  for (let i = 1; i <= 3; i++) {
    const out = await enforceRateLimit(store, r, opts);
    assert.equal(out.hits, i);
    assert.equal(out.remaining, 3 - i);
  }
  await assert.rejects(
    () => enforceRateLimit(store, r, opts),
    (e) => e.status === 429 && e.retryAfter > 0
  );
});

test("el limite es POR IP: una IP bloqueada no afecta a otra", async () => {
  const store = createStore();
  const opts = { name: "prueba", limit: 2, windowSec: 60 };
  const a = req({ "x-forwarded-for": "1.1.1.1" });
  const b = req({ "x-forwarded-for": "2.2.2.2" });

  await enforceRateLimit(store, a, opts);
  await enforceRateLimit(store, a, opts);
  await assert.rejects(() => enforceRateLimit(store, a, opts), (e) => e.status === 429);

  // La otra IP sigue pudiendo comprar.
  assert.equal((await enforceRateLimit(store, b, opts)).hits, 1);
});

test("el discriminador `extra` separa contadores (p. ej. por rifa)", async () => {
  const store = createStore();
  const r = req({ "x-forwarded-for": "1.1.1.1" });
  const base = { name: "reserve", limit: 1, windowSec: 60 };

  await enforceRateLimit(store, r, { ...base, extra: "rifa-a" });
  await assert.rejects(() => enforceRateLimit(store, r, { ...base, extra: "rifa-a" }), (e) => e.status === 429);
  // Otra rifa: contador independiente.
  assert.equal((await enforceRateLimit(store, r, { ...base, extra: "rifa-b" })).hits, 1);
});

test("la ventana se reinicia al expirar", async () => {
  const store = createStore();
  const r = req({ "x-forwarded-for": "1.1.1.1" });
  // Ventana de 1s para no dormir mucho.
  const opts = { name: "prueba", limit: 1, windowSec: 1 };
  await enforceRateLimit(store, r, opts);
  await assert.rejects(() => enforceRateLimit(store, r, opts), (e) => e.status === 429);

  await new Promise((r2) => setTimeout(r2, 1100));
  assert.equal((await enforceRateLimit(store, r, opts)).hits, 1, "nueva ventana, contador limpio");
});

test("limit=0 desactiva el rate limiting", async () => {
  const store = createStore();
  const r = req({ "x-forwarded-for": "1.1.1.1" });
  for (let i = 0; i < 50; i++) {
    const out = await enforceRateLimit(store, r, { name: "off", limit: 0, windowSec: 60 });
    assert.equal(out.skipped, true);
  }
});

test("cleanupRateLimits borra solo las ventanas vencidas", async () => {
  const store = createStore();
  store.hitRateLimit("vieja", new Date(Date.now() - 1000));
  store.hitRateLimit("vigente", new Date(Date.now() + 60_000));
  assert.equal(store.cleanupRateLimits(), 1);
  assert.equal(store.hitRateLimit("vigente", new Date(Date.now() + 60_000)), 2, "la vigente conserva su cuenta");
});

// ---- El ataque que esto previene, extremo a extremo ----
test("ATAQUE: un script no puede bloquear la rifa entera reservando sin pagar", async (t) => {
  const { handler } = await import("../src/app.js");
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const port = server.address().port;

  const reservar = (n) =>
    new Promise((resolve) => {
      const body = JSON.stringify({ number: n, buyer: { firstName: "Bot", lastName: "Malo" } });
      const r = http.request(
        { host: "127.0.0.1", port, method: "POST", path: "/api/raffles/sorteo-demo/reserve",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "6.6.6.6" } },
        (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }
      );
      r.write(body);
      r.end();
    });

  // El atacante intenta reservar 40 numeros seguidos.
  const codigos = [];
  for (let n = 30; n < 70; n++) codigos.push(await reservar(n));

  const bloqueados = codigos.filter((c) => c === 429).length;
  const exitosos = codigos.filter((c) => c === 201).length;
  assert.ok(bloqueados > 0, "el rate limit debe cortar el ataque");
  assert.ok(exitosos <= 15, `no debe dejar reservar mas de 15, dejo ${exitosos}`);
});
