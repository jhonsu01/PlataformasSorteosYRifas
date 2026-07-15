import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  hashPassword, verifyPassword, signJwt, verifyJwt,
  base32Encode, base32Decode, totpCode, verifyTotp, generateTotpSecret,
} from "../src/crypto-utils.js";
import { createStore } from "../src/store.js";
import { login, refreshSession, requireLevel, enableTotp, setupTotp } from "../src/auth.js";
import { handler } from "../src/app.js";

// --------------------------- Primitivas ---------------------------
test("scrypt: acepta la contrasena correcta y rechaza la incorrecta", async () => {
  const h = await hashPassword("una-clave-larga-123");
  assert.equal(await verifyPassword("una-clave-larga-123", h), true);
  assert.equal(await verifyPassword("otra-clave", h), false);
  // Sal aleatoria: dos hashes de la misma clave deben diferir.
  assert.notEqual(h, await hashPassword("una-clave-larga-123"));
});

test("JWT: valida firma y expiracion, rechaza manipulacion", () => {
  const t = signJwt({ sub: "u1", role: "ADMIN" }, "secreto", 900);
  assert.equal(verifyJwt(t, "secreto").role, "ADMIN");
  assert.equal(verifyJwt(t, "secreto-malo"), null, "otro secreto no debe validar");
  assert.equal(verifyJwt(signJwt({ sub: "u1" }, "secreto", -1), "secreto"), null, "expirado");
  assert.equal(verifyJwt(t.slice(0, -3) + "aaa", "secreto"), null, "firma manipulada");
  assert.equal(verifyJwt("no-es-un-jwt", "secreto"), null);
});

test("base32: ida y vuelta", () => {
  const buf = Buffer.from("12345678901234567890", "ascii");
  assert.equal(base32Decode(base32Encode(buf)).toString("ascii"), "12345678901234567890");
});

// Vectores oficiales del RFC 6238 (SHA1, secreto ASCII "12345678901234567890").
// Si esto pasa, los codigos coinciden con Google Authenticator / Authy.
test("TOTP: coincide con los vectores de prueba del RFC 6238", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  const vectores = [
    [59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
    [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"],
  ];
  for (const [t, esperado] of vectores) {
    assert.equal(totpCode(secret, { time: t * 1000, digits: 8 }), esperado, `T=${t}`);
  }
});

test("TOTP: verifica con ventana y rechaza codigos malos", () => {
  const secret = generateTotpSecret();
  const ahora = Date.now();
  assert.equal(verifyTotp(secret, totpCode(secret, { time: ahora }), { time: ahora }), true);
  // Codigo del periodo anterior: aceptado por la ventana de tolerancia.
  assert.equal(verifyTotp(secret, totpCode(secret, { time: ahora - 30000 }), { time: ahora }), true);
  // Muy viejo: rechazado.
  assert.equal(verifyTotp(secret, totpCode(secret, { time: ahora - 300000 }), { time: ahora }), false);
  assert.equal(verifyTotp(secret, "000000", { time: ahora }), false);
  assert.equal(verifyTotp(secret, "abcdef", { time: ahora }), false);
  assert.equal(verifyTotp(secret, "", { time: ahora }), false);
});

// --------------------------- Login / roles ---------------------------
async function storeConAdmin(role = "ADMIN") {
  const store = createStore();
  await store.createAdmin({ email: "admin@test.com", passwordHash: await hashPassword("clave-larga-123"), role });
  return store;
}

test("login: correcto devuelve tokens; malo devuelve 401", async () => {
  const store = await storeConAdmin();
  const s = await login(store, { email: "admin@test.com", password: "clave-larga-123" });
  assert.ok(s.accessToken && s.refreshToken);
  assert.equal(s.user.email, "admin@test.com");
  assert.equal(s.mustEnable2fa, true, "ADMIN sin 2FA debe pedir activarlo");
  assert.ok(!("passwordHash" in s.user), "no debe filtrar el hash");

  await assert.rejects(() => login(store, { email: "admin@test.com", password: "mala" }), /Credenciales invalidas/);
  // Usuario inexistente: mismo mensaje (no revela si el correo existe).
  await assert.rejects(() => login(store, { email: "nadie@test.com", password: "x" }), /Credenciales invalidas/);
});

test("login: con 2FA activo exige el codigo TOTP", async () => {
  const store = await storeConAdmin();
  const user = await store.getAdminByEmail("admin@test.com");
  const { secret } = await setupTotp(store, user);
  await enableTotp(store, user, totpCode(secret));

  await assert.rejects(
    () => login(store, { email: "admin@test.com", password: "clave-larga-123" }),
    (e) => e.totpRequired === true
  );
  await assert.rejects(
    () => login(store, { email: "admin@test.com", password: "clave-larga-123", totp: "000000" }),
    /2FA invalido/
  );
  const s = await login(store, { email: "admin@test.com", password: "clave-larga-123", totp: totpCode(secret) });
  assert.ok(s.accessToken);
  assert.equal(s.mustEnable2fa, false);
});

test("refresh: rota el token y el viejo deja de servir", async () => {
  const store = await storeConAdmin();
  const s1 = await login(store, { email: "admin@test.com", password: "clave-larga-123" });
  const s2 = await refreshSession(store, s1.refreshToken);
  assert.ok(s2.accessToken);
  assert.notEqual(s2.refreshToken, s1.refreshToken);
  await assert.rejects(() => refreshSession(store, s1.refreshToken), /invalido o expirado/);
});

test("roles: OPERATOR no puede hacer acciones de ADMIN", () => {
  assert.throws(() => requireLevel({ role: "OPERATOR" }, "ADMIN"), /Permiso insuficiente/);
  assert.doesNotThrow(() => requireLevel({ role: "ADMIN" }, "ADMIN"));
  assert.doesNotThrow(() => requireLevel({ role: "SUPER_ADMIN" }, "ADMIN"));
  assert.doesNotThrow(() => requireLevel({ role: "OPERATOR" }, "OPERATOR"));
});

// --------------------------- Endpoints protegidos ---------------------------
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
    // Ojo: enviar body en un GET hace que Node responda 400 antes de llegar al
    // handler (chunked encoding en un metodo sin cuerpo). Solo se escribe si aplica.
    if (body && method !== "GET") req.write(JSON.stringify(body));
    req.end();
  });
}

test("los endpoints de administracion rechazan peticiones sin credenciales", async (t) => {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());

  const protegidos = [
    ["POST", "/api/raffles"],
    ["GET", "/api/raffles/sorteo-demo/purchases"],
    ["POST", "/api/purchases/abc/approve"],
    ["POST", "/api/purchases/abc/reject"],
    ["POST", "/api/raffles/sorteo-demo/draw"],
  ];
  for (const [m, p] of protegidos) {
    const r = await pedir(server, m, p, { body: {} });
    assert.equal(r.status, 401, `${m} ${p} deberia exigir autenticacion`);
  }

  // Con un token invalido tampoco.
  const r = await pedir(server, "POST", "/api/raffles", { token: "basura", body: {} });
  assert.equal(r.status, 401);

  // Y lo publico sigue abierto. Se comprueba que NO pidan autenticacion (401);
  // un 404 es valido aqui (con base real no se siembra la rifa demo).
  for (const [m, p] of [["GET", "/health"], ["GET", "/api/raffles"], ["GET", "/api/raffles/sorteo-demo/public/numbers.json"]]) {
    const ok = await pedir(server, m, p);
    assert.notEqual(ok.status, 401, `${m} ${p} deberia ser publico`);
    assert.notEqual(ok.status, 403, `${m} ${p} deberia ser publico`);
  }
});
