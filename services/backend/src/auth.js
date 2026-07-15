// Autenticacion y autorizacion (Guia 5.1-5.3).
//   - Contrasena scrypt + TOTP (2FA) obligatorio para SUPER_ADMIN/ADMIN.
//   - JWT de acceso corto + refresh token ROTATIVO (el viejo se revoca al usarlo).
//   - Del refresh solo se guarda su hash: si se filtra la base, no sirven.

import { config } from "./config.js";
import { httpError } from "./store.js";
import {
  signJwt, verifyJwt, hashPassword, verifyPassword,
  generateTotpSecret, verifyTotp, totpUri, randomToken, sha256,
} from "./crypto-utils.js";

export const ROLE_LEVEL = { OPERATOR: 1, ADMIN: 2, SUPER_ADMIN: 3 };

// Hash señuelo: se verifica igual cuando el correo no existe, para que el tiempo
// de respuesta no revele si un usuario esta registrado (enumeracion de usuarios).
let dummyHash = null;
async function getDummyHash() {
  if (!dummyHash) dummyHash = await hashPassword(randomToken(16));
  return dummyHash;
}

export const publicUser = (u) => ({ id: u.id, email: u.email, role: u.role, totpEnabled: u.totpEnabled });

function bearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : null;
}

export async function currentUser(req, store) {
  const token = bearer(req);
  if (!token) return null;
  const payload = verifyJwt(token, config.jwt.accessSecret);
  if (!payload?.sub) return null;
  return (await store.getAdminById(payload.sub)) || null;
}

export async function requireAuth(req, store) {
  const u = await currentUser(req, store);
  if (!u) throw httpError(401, "No autenticado");
  return u;
}

/** Exige un rol minimo. OPERATOR < ADMIN < SUPER_ADMIN. */
export function requireLevel(user, minRole) {
  if ((ROLE_LEVEL[user.role] || 0) < (ROLE_LEVEL[minRole] || 99)) {
    throw httpError(403, "Permiso insuficiente para esta accion");
  }
  return user;
}

async function issueTokens(store, user) {
  const accessToken = signJwt(
    { sub: user.id, role: user.role, email: user.email },
    config.jwt.accessSecret,
    config.jwt.accessTtl
  );
  const refreshToken = randomToken(32);
  await store.saveRefreshToken(
    sha256(refreshToken),
    user.id,
    new Date(Date.now() + config.jwt.refreshTtl * 1000)
  );
  return {
    accessToken,
    refreshToken,
    expiresIn: config.jwt.accessTtl,
    user: publicUser(user),
    // La Guia exige 2FA para SUPER_ADMIN/ADMIN: avisa si aun no esta configurado.
    mustEnable2fa: !user.totpEnabled && ROLE_LEVEL[user.role] >= ROLE_LEVEL.ADMIN,
  };
}

export async function login(store, { email, password, totp }) {
  const user = await store.getAdminByEmail(email);
  const ok = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, await getDummyHash());
  if (!user || !ok) throw httpError(401, "Credenciales invalidas");

  if (user.totpEnabled) {
    if (!totp) {
      const e = httpError(401, "Se requiere el codigo de 2FA");
      e.totpRequired = true;
      throw e;
    }
    if (!verifyTotp(user.totpSecret, totp)) throw httpError(401, "Codigo 2FA invalido");
  }

  await store.touchAdminLogin(user.id);
  await store.audit({ actor: user.email, action: "LOGIN", entityType: "admin_user", entityId: user.id });
  return issueTokens(store, user);
}

/** Rotacion: el refresh usado se revoca y se emite uno nuevo. */
export async function refreshSession(store, refreshToken) {
  const hash = sha256(refreshToken || "");
  const row = await store.getRefreshToken(hash);
  if (!row) throw httpError(401, "Refresh token invalido o expirado");
  await store.revokeRefreshToken(hash);
  const user = await store.getAdminById(row.userId);
  if (!user) throw httpError(401, "El usuario ya no existe");
  return issueTokens(store, user);
}

export async function logout(store, refreshToken) {
  if (refreshToken) await store.revokeRefreshToken(sha256(refreshToken));
  return { ok: true };
}

/** Genera un secreto TOTP y su URI; no activa 2FA hasta confirmar un codigo. */
export async function setupTotp(store, user) {
  const secret = generateTotpSecret();
  await store.setAdminTotp(user.id, secret, false);
  return { secret, uri: totpUri(secret, { account: user.email }) };
}

export async function enableTotp(store, user, code) {
  const fresh = await store.getAdminById(user.id);
  if (!fresh?.totpSecret) throw httpError(400, "Primero genera el secreto (setup)");
  if (!verifyTotp(fresh.totpSecret, code)) throw httpError(400, "Codigo invalido: revisa la hora del dispositivo");
  await store.setAdminTotp(user.id, fresh.totpSecret, true);
  await store.audit({ actor: user.email, action: "ENABLE_2FA", entityType: "admin_user", entityId: user.id });
  return { ok: true, totpEnabled: true };
}

export { hashPassword };
