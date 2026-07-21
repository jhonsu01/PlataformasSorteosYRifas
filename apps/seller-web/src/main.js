// App de VENDEDOR (promotor). SPA autocontenida que consume la MISMA API del
// backend que el admin, pero con permisos de OPERATOR: solo ve sus rifas
// asignadas y solo puede VERIFICAR (aprobar) pagos manuales. No puede anular ni
// rechazar (eso es del admin) ni crear rifas. Puede activar su propio 2FA.
//
// Se empaqueta en un APK (apps/seller-android) como WebView, y tambien corre como
// web normal para desarrollo.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// --------------------------- Configuracion ---------------------------
const CFG_KEY = "srSellerCfg";
const REFRESH_KEY = "srSellerRefresh";
const DEFAULT_CFG = { backendUrl: "https://plataformas-sorteos-y-rifas.vercel.app" };

function loadCfg() {
  try { return { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem(CFG_KEY) || "{}") }; }
  catch { return { ...DEFAULT_CFG }; }
}
let cfg = loadCfg();
function saveCfg(next) { cfg = { ...cfg, ...next }; localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

const getRefresh = () => localStorage.getItem(REFRESH_KEY);
const setRefresh = (t) => (t ? localStorage.setItem(REFRESH_KEY, t) : localStorage.removeItem(REFRESH_KEY));

// --------------------------- Sesion / API ---------------------------
let accessToken = null;
let session = null;

function applySession(s) { accessToken = s.accessToken; session = s.user; if (s.refreshToken) setRefresh(s.refreshToken); }

async function raw(path, { method = "GET", body, token } = {}) {
  const base = String(cfg.backendUrl || "").replace(/\/$/, "");
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

async function api(path, opts = {}) {
  try { return await raw(path, { ...opts, token: accessToken }); }
  catch (e) {
    if (e.status !== 401 || !getRefresh()) throw e;
    try { applySession(await raw("/api/auth/refresh", { method: "POST", body: { refreshToken: getRefresh() } })); }
    catch { cerrarSesion(); throw new Error("Sesión expirada. Vuelve a iniciar sesión."); }
    return await raw(path, { ...opts, token: accessToken });
  }
}

async function restaurarSesion() {
  if (!getRefresh()) return false;
  try { applySession(await raw("/api/auth/refresh", { method: "POST", body: { refreshToken: getRefresh() } })); return true; }
  catch { setRefresh(null); return false; }
}

function cerrarSesion() {
  const r = getRefresh();
  if (r) raw("/api/auth/logout", { method: "POST", body: { refreshToken: r } }).catch(() => {});
  accessToken = null; session = null; setRefresh(null);
}

let backendOnline = false;
async function checkHealth() {
  const badge = $("#conn");
  try {
    const base = String(cfg.backendUrl || "").replace(/\/$/, "");
    const r = await fetch(base + "/health");
    if (!r.ok) throw new Error();
    backendOnline = true;
    if (badge) badge.textContent = "● conectado";
    return true;
  } catch {
    backendOnline = false;
    if (badge) badge.textContent = "● sin conexión";
    return false;
  }
}

// --------------------------- Toast ---------------------------
let toastT;
function toast(msg, ok = true) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (ok ? "" : " err");
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.className = "toast"), 3200);
}

// --------------------------- Router ---------------------------
const VIEWS = {};
let current = "login";
const PUBLICAS = new Set(["login", "config"]);

function setView(name) {
  if (!session && !PUBLICAS.has(name)) name = "login";
  current = name;
  const tb = $("#tabbar");
  tb.style.display = session ? "flex" : "none";
  tb.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  $("#who").textContent = session ? (session.fullName || session.email) : "";
  render();
}

async function render() {
  const el = $("#view");
  el.innerHTML = `<div class="loading">Cargando…</div>`;
  try { await VIEWS[current](el); }
  catch (e) { el.innerHTML = `<div class="panel error-box">Error: ${esc(e.message)}</div>`; }
}

function bannerOffline() {
  return backendOnline ? "" : `<div class="banner-warn">⚠️ Sin conexión con el backend. Revisa la URL en <b>Ajustes</b> o tu conexión.</div>`;
}

// --------------------------- Vista: Login ---------------------------
VIEWS.login = async (el) => {
  await checkHealth();
  el.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-brand">🎟️</div>
        <h2>Ingreso de vendedor</h2>
        <p class="muted small" style="margin-bottom:16px">Usa el correo y la contraseña que te envió el administrador.</p>
        ${bannerOffline()}
        <form id="form-login">
          <label class="fld">Correo<input name="email" type="email" required autocomplete="username" /></label>
          <label class="fld">Contraseña<input name="password" type="password" required autocomplete="current-password" /></label>
          <label class="fld" id="totp-fld" style="display:none">Código 2FA<input name="totp" inputmode="numeric" placeholder="6 dígitos" /></label>
          <button type="submit" class="btn-primary">Entrar</button>
        </form>
        <button class="btn-link" id="ir-config">Cambiar backend (Ajustes)</button>
      </div>
    </div>`;

  $("#ir-config").onclick = () => setView("config");
  $("#form-login").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { email: fd.get("email"), password: fd.get("password") };
    const totp = fd.get("totp"); if (totp) body.totp = totp;
    try {
      applySession(await raw("/api/auth/login", { method: "POST", body }));
      setView("rifas");
    } catch (err) {
      if (err.data?.totpRequired) {
        $("#totp-fld").style.display = "flex";
        toast("Ingresa tu código de 2FA", false);
      } else {
        toast(err.message, false);
      }
    }
  };
};

// --------------------------- Vista: Rifas asignadas ---------------------------
let rifaSel = null; // slug elegido para ver comprobantes

VIEWS.rifas = async (el) => {
  await checkHealth();
  if (!backendOnline) { el.innerHTML = bannerOffline(); return; }

  if (rifaSel) return renderComprobantes(el, rifaSel);

  const { raffles } = await api("/api/seller/raffles");
  el.innerHTML = `
    <h2>Tus rifas</h2>
    <p class="muted small" style="margin-bottom:12px">Toca una rifa para verificar sus pagos manuales pendientes.</p>
    <ul class="rifa-list">
      ${raffles.length === 0 ? `<li class="panel muted">Aún no tienes rifas asignadas. Pídele al administrador que te asigne alguna.</li>` : ""}
      ${raffles.map((r) => `
        <li class="rifa-card" data-slug="${esc(r.slug)}">
          <div class="rifa-title">${esc(r.title)}</div>
          <div class="rifa-meta">${esc(r.slug)} · ${esc(r.status || "")}</div>
          <span class="rifa-badge">Verificar pagos →</span>
        </li>`).join("")}
    </ul>`;

  el.querySelectorAll(".rifa-card").forEach((c) => {
    c.onclick = () => { rifaSel = c.dataset.slug; render(); };
  });
};

async function renderComprobantes(el, slug) {
  const { purchases } = await api(`/api/raffles/${slug}/purchases?status=PENDING`);
  // Los que ya mandaron comprobante van primero: son los que esperan respuesta.
  const lista = [...purchases].sort((a, b) => (a.hasReceipt === b.hasReceipt ? 0 : a.hasReceipt ? -1 : 1));

  el.innerHTML = `
    <button class="btn-link" id="volver">← Mis rifas</button>
    <h2>Pagos pendientes</h2>
    <p class="muted small" style="margin-bottom:12px">${esc(slug)} · Verificar aprueba el pago y marca el número como vendido. No se puede anular después (eso lo hace el administrador).</p>
    <ul class="approvals">
      ${lista.length === 0 ? `<li class="panel muted">No hay pagos pendientes. 🎉</li>` : ""}
      ${lista.map((p) => `
        <li class="approval" data-id="${esc(p.id)}">
          <div class="who">${esc(p.buyer)} · Número ${esc(String(p.number))}</div>
          <div class="meta">${esc(p.method)} · ${p.contact?.phone ? esc(p.contact.phone) : "sin teléfono"}${p.city ? ` · 📍 ${esc(p.city)}` : ""}</div>
          <div class="meta">${new Date(p.purchasedAt).toLocaleString("es-CO")}</div>
          <div class="actions">
            ${p.hasReceipt
              ? `<button class="btn-ghost" data-receipt="${esc(p.id)}">🧾 Ver comprobante</button>`
              : p.method === "MANUAL" ? `<div class="meta">⏳ Sin comprobante todavía</div>` : ""}
            <button class="btn-approve" data-approve="${esc(p.id)}">✔️ Verificar pago (vender)</button>
          </div>
        </li>`).join("")}
    </ul>`;

  $("#volver").onclick = () => { rifaSel = null; render(); };
  el.querySelectorAll("[data-receipt]").forEach((b) => (b.onclick = () => verComprobante(b.dataset.receipt)));
  el.querySelectorAll("[data-approve]").forEach((b) => (b.onclick = async () => {
    // Aviso IMPORTANTE antes de vender: el vendedor debe haber recibido el dinero
    // y revisado el comprobante. Se usa un modal propio (no confirm()): el WebView
    // de Android suprime window.confirm() y el boton parecia "no hacer nada".
    const ok = await confirmarModal({
      titulo: "Verificar pago",
      mensaje: "⚠️ Antes de aprobar, confirma que YA recibiste el dinero de este número y revisaste el comprobante.\n\nAl verificar, el número queda VENDIDO y no podrás anularlo (eso solo lo hace el administrador).",
      okLabel: "Sí, ya recibí el pago — Vender",
    });
    if (!ok) return;
    try { await api(`/api/purchases/${b.dataset.approve}/approve`, { method: "POST", body: {} });
      toast("Pago verificado · número vendido"); render();
    } catch (e) { toast(e.message, false); }
  }));
}

/**
 * Confirmacion en un modal propio (Promise<boolean>). No usa window.confirm(),
 * que el WebView de Android suprime por no tener WebChromeClient de dialogos.
 */
function confirmarModal({ titulo, mensaje, okLabel = "Confirmar", cancelLabel = "Cancelar" }) {
  return new Promise((resolve) => {
    const m = $("#modal");
    m.classList.add("show");
    m.innerHTML = `
      <div class="modal-card">
        <div class="modal-head"><b>${esc(titulo)}</b></div>
        <div class="modal-body" style="text-align:left">
          <p style="white-space:pre-line;margin-bottom:16px">${esc(mensaje)}</p>
          <button class="btn-approve" id="cm-ok" style="margin-bottom:8px">${esc(okLabel)}</button>
          <button class="btn-ghost" id="cm-cancel">${esc(cancelLabel)}</button>
        </div>
      </div>`;
    const cerrar = (val) => { m.innerHTML = ""; m.classList.remove("show"); resolve(val); };
    $("#cm-ok").onclick = () => cerrar(true);
    $("#cm-cancel").onclick = () => cerrar(false);
    m.onclick = (e) => { if (e.target === m) cerrar(false); };
  });
}

async function verComprobante(purchaseId) {
  const m = $("#modal");
  m.classList.add("show");
  m.innerHTML = `<div class="modal-card"><div class="modal-body"><p class="muted">Cargando comprobante…</p></div></div>`;
  let url;
  try {
    const res = await fetch(`${cfg.backendUrl.replace(/\/$/, "")}/api/purchases/${purchaseId}/receipt`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`No se pudo cargar el comprobante (HTTP ${res.status})`);
    url = URL.createObjectURL(await res.blob());
    m.innerHTML = `
      <div class="modal-card">
        <div class="modal-head"><b>Comprobante del pago</b><button class="btn-link" id="rc-cerrar">Cerrar</button></div>
        <div class="modal-body"><img src="${url}" alt="Comprobante" class="receipt-img" /></div>
      </div>`;
    const cerrar = () => { URL.revokeObjectURL(url); m.innerHTML = ""; m.classList.remove("show"); };
    $("#rc-cerrar").onclick = cerrar;
    m.onclick = (e) => { if (e.target === m) cerrar(); };
  } catch (e) {
    if (url) URL.revokeObjectURL(url);
    m.innerHTML = ""; m.classList.remove("show");
    toast(e.message, false);
  }
}

// --------------------------- Vista: Seguridad (2FA) ---------------------------
VIEWS.seguridad = async (el) => {
  await checkHealth();
  if (!backendOnline) { el.innerHTML = bannerOffline(); return; }
  const { user } = await api("/api/auth/me");
  session = user;

  el.innerHTML = `
    <h2>Seguridad</h2>
    <section class="panel">
      <p class="small">Verificación en dos pasos (2FA): ${user.totpEnabled ? "✅ <b>activa</b>" : "— sin activar"}</p>
      ${user.totpEnabled ? `<p class="muted small">Tu cuenta ya pide un código además de la contraseña. 👍</p>` : `
        <p class="muted small" style="margin:8px 0">Recomendado: protege tu cuenta con una app de autenticación (Google Authenticator, Authy…).</p>
        <button class="btn-primary" id="btn-2fa">Activar 2FA</button>`}
    </section>
    <div id="totp-zone"></div>
    <button class="btn-link" id="logout">Cerrar sesión</button>`;

  $("#logout").onclick = () => { cerrarSesion(); setView("login"); };
  const btn = $("#btn-2fa");
  if (btn) btn.onclick = async () => {
    try {
      const { secret, uri } = await api("/api/auth/totp/setup", { method: "POST" });
      $("#totp-zone").innerHTML = `
        <section class="panel">
          <p class="small">1) Agrega este secreto en tu app de autenticación:</p>
          <div class="secret-box">${esc(secret)}</div>
          <p class="muted small">O abre: <a href="${esc(uri)}">${esc(uri)}</a></p>
          <label class="fld" style="margin-top:10px">2) Escribe el código que muestra la app<input id="totp-code" inputmode="numeric" placeholder="6 dígitos" /></label>
          <button class="btn-approve" id="btn-2fa-ok">Confirmar y activar</button>
        </section>`;
      $("#btn-2fa-ok").onclick = async () => {
        try { await api("/api/auth/totp/enable", { method: "POST", body: { code: $("#totp-code").value } });
          toast("2FA activado ✅"); render();
        } catch (e) { toast(e.message, false); }
      };
    } catch (e) { toast(e.message, false); }
  };
};

// --------------------------- Vista: Ajustes ---------------------------
VIEWS.config = async (el) => {
  el.innerHTML = `
    <h2>Ajustes</h2>
    <section class="panel">
      <label class="fld">URL del backend<input id="cfg-url" value="${esc(cfg.backendUrl)}" /></label>
      <button class="btn-primary" id="cfg-save">Guardar</button>
      <button class="btn-link" id="cfg-test">Probar conexión</button>
    </section>
    <p class="muted small">Por seguridad, tu app solo se comunica con el backend. Las llaves de pago y los secretos viven en el servidor, nunca en este dispositivo.</p>`;

  $("#cfg-save").onclick = () => {
    saveCfg({ backendUrl: $("#cfg-url").value.trim() });
    toast("Guardado");
    setView(session ? "rifas" : "login");
  };
  $("#cfg-test").onclick = async () => { toast((await checkHealth()) ? "Conectado ✅" : "Sin conexión", backendOnline); };
};

// --------------------------- Arranque ---------------------------
document.querySelectorAll("#tabbar button").forEach((b) => {
  b.onclick = () => { if (b.dataset.view === "rifas") rifaSel = null; setView(b.dataset.view); };
});

(async function boot() {
  await checkHealth();
  const hay = await restaurarSesion();
  setView(hay ? "rifas" : "login");
  setInterval(checkHealth, 30_000);
})();
