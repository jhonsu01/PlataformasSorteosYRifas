// App Admin (Tauri v2). SPA sin framework: navegacion real + configuracion
// persistente + conexion al backend (services/backend). Si el backend no esta
// disponible, cada vista lo indica y el Panel cae a los datos publicos.

// --------------------------- Config persistente ---------------------------
const DEFAULTS = {
  backendUrl: "http://localhost:8787",
  raffleSlug: "sorteo-demo",
  pollSeconds: 15,
};
function loadCfg() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("srCfg") || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveCfg(cfg) {
  localStorage.setItem("srCfg", JSON.stringify(cfg));
}
let cfg = loadCfg();

// --------------------------- Utilidades ---------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const copFormat = (cents) =>
  new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format((cents || 0) / 100);

/**
 * Número de rifa con ceros a la izquierda: 1 -> "001".
 * En Colombia el ganador suele salir de las últimas 3 cifras de una lotería
 * externa, así que "001" es un número distinto de "010" o "100".
 * El ancho se deriva del máximo del rango (999 -> 3 dígitos, 99 -> 2).
 */
const padNum = (n, max) => String(n).padStart(String(max ?? 0).length, "0");

function toast(msg, ok = true) {
  const t = $("#toast");
  t.textContent = msg;
  t.style.background = ok ? "#1f2937" : "#b91c1c";
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2600);
}

function invoke(cmd, args) {
  if (window.__TAURI__?.core) return window.__TAURI__.core.invoke(cmd, args);
  return Promise.reject(new Error("Tauri no disponible"));
}

// --------------------------- Sesion ---------------------------
// El access token vive en memoria (no se persiste). El refresh sí, para no
// re-pedir la clave en cada arranque; se rota en cada uso.
let accessToken = null;
let session = null; // { user, mustEnable2fa }

const getRefresh = () => localStorage.getItem("srRefresh");
const setRefresh = (t) => (t ? localStorage.setItem("srRefresh", t) : localStorage.removeItem("srRefresh"));

function applySession(s) {
  accessToken = s.accessToken;
  setRefresh(s.refreshToken);
  session = { user: s.user, mustEnable2fa: s.mustEnable2fa };
  return session;
}

async function raw(path, { method = "GET", body, token } = {}) {
  const res = await fetch(cfg.backendUrl.replace(/\/$/, "") + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.totpRequired = data.totpRequired;
    throw err;
  }
  return data;
}

/** Cliente HTTP: añade el token y renueva la sesión si expiró (401). */
async function api(path, opts = {}) {
  try {
    return await raw(path, { ...opts, token: accessToken });
  } catch (e) {
    if (e.status !== 401 || !getRefresh()) throw e;
    // Access token vencido: renovar con el refresh y reintentar una vez.
    try {
      applySession(await raw("/api/auth/refresh", { method: "POST", body: { refreshToken: getRefresh() } }));
    } catch {
      cerrarSesion();
      throw new Error("Sesión expirada. Vuelve a iniciar sesión.");
    }
    return await raw(path, { ...opts, token: accessToken });
  }
}

async function restaurarSesion() {
  if (!getRefresh()) return false;
  try {
    applySession(await raw("/api/auth/refresh", { method: "POST", body: { refreshToken: getRefresh() } }));
    return true;
  } catch {
    setRefresh(null);
    return false;
  }
}

function cerrarSesion() {
  const r = getRefresh();
  if (r) raw("/api/auth/logout", { method: "POST", body: { refreshToken: r } }).catch(() => {});
  accessToken = null;
  session = null;
  setRefresh(null);
}

let backendOnline = false;
/**
 * Comprueba /health. Acepta `urlOverride` para poder probar una URL AÚN NO
 * guardada (el botón "Probar conexión" de Configuración).
 * No usa api(): /health es público y no debe disparar el refresh de sesión.
 */
async function checkHealth(urlOverride) {
  const badge = $("#conn-badge");
  const base = String(urlOverride || cfg.backendUrl || "").replace(/\/$/, "");
  try {
    const r = await fetch(base + "/health");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const h = await r.json();
    backendOnline = true;
    if (badge) {
      badge.textContent = `● Backend conectado (${h.env})`;
      badge.className = "conn conn-on";
    }
    return h;
  } catch {
    backendOnline = false;
    if (badge) {
      badge.textContent = "● Backend no conectado";
      badge.className = "conn conn-off";
    }
    return null;
  }
}

// --------------------------- Router ---------------------------
const VIEWS = {};
let current = "panel";

// Vistas que no requieren sesion iniciada.
const PUBLICAS = new Set(["login", "config"]);

function setView(name) {
  // Guard: sin sesion solo se puede ver el login (y la config, para apuntar al backend).
  if (!session && !PUBLICAS.has(name)) name = "login";
  current = name;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelector(".sidebar").style.display = session || name === "config" ? "" : "none";
  pintarUsuario();
  render();
}

function pintarUsuario() {
  const box = document.getElementById("user-box");
  if (!box) return;
  if (!session) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="user-mail">${esc(session.user.email)}</div>
    <div class="user-role">${esc(session.user.role)}${session.user.totpEnabled ? " · 2FA ✓" : ""}</div>
    <button id="btn-logout" class="btn-logout">Cerrar sesión</button>`;
  document.getElementById("btn-logout").onclick = () => {
    cerrarSesion();
    toast("Sesión cerrada");
    setView("login");
  };
}

async function render() {
  const el = $("#view");
  el.innerHTML = `<div class="loading">Cargando…</div>`;
  try {
    await VIEWS[current](el);
  } catch (e) {
    el.innerHTML = `<div class="panel error-box">Error: ${esc(e.message)}</div>`;
  }
}

function backendBanner() {
  let html = "";
  if (!backendOnline) {
    html += `<div class="banner-warn">⚠️ Backend no conectado. Inícialo con <code>cd services/backend &amp;&amp; npm start</code> o ajusta la URL en <b>Configuración</b>.</div>`;
  }
  if (session?.mustEnable2fa) {
    html += `<div class="banner-warn">🔐 Tu cuenta aún no tiene 2FA. <b>Actívalo en Seguridad</b>: sin él, una contraseña filtrada basta para aprobar pagos.</div>`;
  }
  return html;
}

// --------------------------- Vista: Login ---------------------------
VIEWS.login = async (el) => {
  await checkHealth();
  el.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-brand">🎟️</div>
        <h1>Sorteos y Rifas</h1>
        <p class="muted small">Panel de administración</p>
        ${!backendOnline ? `<div class="banner-warn" style="margin-top:16px">No hay conexión con el backend (<code>${esc(cfg.backendUrl)}</code>). Ajústalo en Configuración.</div>` : ""}
        <form id="form-login" style="margin-top:18px">
          <label class="fld">Correo<input name="email" type="email" required autocomplete="username" /></label>
          <label class="fld">Contraseña<input name="password" type="password" required autocomplete="current-password" /></label>
          <label class="fld" id="fld-totp" style="display:none">Código 2FA (6 dígitos)
            <input name="totp" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" />
          </label>
          <button type="submit" class="btn-approve" style="width:100%;margin-top:6px">Entrar</button>
        </form>
        <button id="ir-config" class="btn-link">Configurar backend</button>
      </div>
    </div>`;

  $("#ir-config").onclick = () => setView("config");
  $("#form-login").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const creds = { email: f.email.value.trim(), password: f.password.value };
    const totp = f.totp.value.trim();
    if (totp) creds.totp = totp;
    try {
      const s = await raw("/api/auth/login", { method: "POST", body: creds });
      applySession(s);
      toast(`Bienvenido, ${s.user.email}`);
      setView(s.mustEnable2fa ? "seguridad" : "panel");
    } catch (err) {
      if (err.totpRequired) {
        $("#fld-totp").style.display = "";
        f.totp.focus();
        toast("Introduce tu código de 2FA");
      } else {
        toast(err.message, false);
      }
    }
  };
};

// --------------------------- Vista: Seguridad (2FA) ---------------------------
VIEWS.seguridad = async (el) => {
  const yaActivo = session?.user?.totpEnabled;
  el.innerHTML = `
    <header class="topbar"><div><h1>Seguridad</h1><p class="muted">Verificación en dos pasos (2FA)</p></div></header>
    ${yaActivo ? `
      <section class="panel"><h2>✅ 2FA activo</h2>
        <p class="muted small">Tu cuenta pide un código temporal al iniciar sesión.</p></section>` : `
      <section class="panel">
        <h2>Activa el 2FA</h2>
        <p class="muted small">La Guía lo exige para cuentas de administración: sin él, una contraseña filtrada basta para aprobar pagos o declarar ganadores.</p>
        <div id="totp-paso1"><button id="btn-setup" class="btn-approve" style="margin-top:12px">Generar secreto</button></div>
        <div id="totp-paso2" style="display:none;margin-top:16px">
          <p class="small">1. Abre Google Authenticator / Authy → <b>Introducir clave manualmente</b>.<br>
             2. Pega este secreto (cuenta: <b>${esc(session?.user?.email || "")}</b>):</p>
          <div class="secret-box" id="secret"></div>
          <p class="small">3. Escribe el código de 6 dígitos que te muestre:</p>
          <form id="form-totp" class="form-grid" style="grid-template-columns:180px auto">
            <label>Código<input name="code" inputmode="numeric" maxlength="6" required /></label>
            <div class="form-actions"><button type="submit" class="btn-approve">Activar 2FA</button></div>
          </form>
        </div>
      </section>`}`;

  const btn = $("#btn-setup");
  if (btn) btn.onclick = async () => {
    try {
      const { secret } = await api("/api/auth/totp/setup", { method: "POST" });
      $("#totp-paso1").style.display = "none";
      $("#totp-paso2").style.display = "";
      $("#secret").textContent = secret.replace(/(.{4})/g, "$1 ").trim();
      $("#form-totp").onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api("/api/auth/totp/enable", { method: "POST", body: { code: e.target.code.value.trim() } });
          session.user.totpEnabled = true;
          session.mustEnable2fa = false;
          toast("2FA activado");
          pintarUsuario();
          render();
        } catch (err) { toast(err.message, false); }
      };
    } catch (err) { toast(err.message, false); }
  };
};

// --------------------------- Vista: Panel ---------------------------
VIEWS.panel = async (el) => {
  await checkHealth();
  let raffle = null, sold = 0, total = 0, pending = 0;
  if (backendOnline) {
    const list = await api("/api/raffles");
    raffle = list.raffles.find((r) => r.slug === cfg.raffleSlug) || list.raffles[0];
    if (raffle) {
      sold = raffle.sold; total = raffle.total; cfg.raffleSlug = raffle.slug; saveCfg(cfg);
      const pend = await api(`/api/raffles/${raffle.slug}/purchases?status=PENDING`);
      pending = pend.purchases.length;
    }
  } else {
    // Fallback: datos publicos de solo lectura.
    try {
      const [r, n] = await Promise.all([
        fetch(`https://raw.githubusercontent.com/jhonsu01/PlataformasSorteosYRifas/main/examples/sorteo-demo/public/raffle.json`).then((x) => x.json()),
        fetch(`https://raw.githubusercontent.com/jhonsu01/PlataformasSorteosYRifas/main/examples/sorteo-demo/public/numbers.json`).then((x) => x.json()),
      ]);
      raffle = { title: r.title, prize: r.prize, priceCents: r.priceCents, numberRange: r.numberRange, status: r.status };
      sold = (n.sold || []).length; total = r.numberRange.max - r.numberRange.min + 1;
    } catch {}
  }
  const pct = total ? Math.round((sold / total) * 100) : 0;

  el.innerHTML = `
    ${backendBanner()}
    <header class="topbar"><div><h1>Panel de control</h1><p class="muted">Estado general del sorteo activo</p></div></header>
    <section class="stats">
      <div class="stat-card"><div class="stat-value">${pending}</div><div class="stat-label">Comprobantes pendientes</div></div>
      <div class="stat-card"><div class="stat-value">${sold}</div><div class="stat-label">Números vendidos</div></div>
      <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">Total de números</div></div>
      <div class="stat-card"><div class="stat-value">${pct}%</div><div class="stat-label">Avance de venta</div></div>
    </section>
    <section class="panel">
      <h2>Rifa activa</h2>
      ${raffle ? `
        <div style="font-size:18px;font-weight:700;margin-bottom:6px">${esc(raffle.title)}</div>
        <div class="kv">
          <div><span class="k">Premio</span><span class="v">${esc(raffle.prize)}</span></div>
          <div><span class="k">Precio / número</span><span class="v">${copFormat(raffle.priceCents)}</span></div>
          <div><span class="k">Rango</span><span class="v">${padNum(raffle.numberRange.min, raffle.numberRange.max)}–${raffle.numberRange.max}</span></div>
          <div><span class="k">Vendidos</span><span class="v">${sold} de ${total}</span></div>
          <div><span class="k">Estado</span><span class="v">${esc(raffle.status)}</span></div>
        </div>
        <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
      ` : `<p class="muted">No hay rifa activa.</p>`}
    </section>`;
};

// --------------------------- Vista: Rifas ---------------------------

/**
 * Linea de estado de publicacion de una rifa.
 *
 * Antes esto se pintaba VACIO y solo se rellenaba si hacias clic en "Publicar"
 * durante esa sesion: al recargar, el enlace desaparecia y una rifa publicada
 * hace semanas se veia igual que una que nunca se publico. El estado ahora
 * viene del backend (`publishedAt` / `repoFullName`), que es donde tiene que
 * estar: un dato que solo existe en la memoria de una ventana no es un dato.
 */
/** Fecha por defecto del formulario: dentro de N dias, a las 8 p. m. */
function fechaPorDefecto(dias) {
  const d = new Date(Date.now() + dias * 864e5);
  d.setHours(20, 0, 0, 0);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function repoLinea(r) {
  if (!r.publishedAt) return `<span class="muted small">Sin publicar</span>`;
  const url = `https://github.com/${r.repoFullName}`;
  const cuando = new Date(r.publishedAt).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });
  return `<a href="${esc(url)}" target="_blank" class="repo-link">📖 ${esc(r.repoFullName)}</a>
          <span class="muted small" title="Última publicación"> · ${esc(cuando)}</span>`;
}

VIEWS.rifas = async (el) => {
  await checkHealth();
  if (!backendOnline) { el.innerHTML = backendBanner(); return; }
  const { raffles } = await api("/api/raffles");
  el.innerHTML = `
    <header class="topbar"><div><h1>Rifas</h1><p class="muted">Gestiona los sorteos</p></div></header>
    <section class="panel">
      <h2>Rifas existentes</h2>
      <div class="rifa-grid">
        ${raffles.map((r) => `
          <div class="rifa-card ${r.slug === cfg.raffleSlug ? "sel" : ""}">
            ${r.cover ? `<img class="rifa-cover" src="${esc(r.cover)}" alt="" />` : ""}
            <div class="rifa-title">${esc(r.title)}</div>
            <div class="muted small">${esc(r.slug)} · ${esc(r.status)}</div>
            <div class="rifa-meta">
              ${r.sold}/${r.total} vendidos · ${copFormat(r.priceCents)}
              ${r.prizeTotalCents ? `<br/>Premio: ${copFormat(r.prizeTotalCents)}` : ""}
            </div>
            <div class="repo-line">${repoLinea(r)}</div>
            <div class="rifa-acciones">
              <button class="btn-approve" data-sel="${esc(r.slug)}">${r.slug === cfg.raffleSlug ? "Activa" : "Seleccionar"}</button>
              <button class="btn-secondary" data-premio="${esc(r.slug)}">Premio y fotos</button>
              <button class="btn-link" data-pub="${esc(r.slug)}">${r.publishedAt ? "Republicar" : "Publicar a GitHub"}</button>
            </div>
          </div>`).join("")}
      </div>
    </section>
    <section class="panel">
      <h2>Nueva rifa</h2>
      <form id="form-rifa" class="form-grid">
        <label>Título<input name="title" required placeholder="Sorteo Moto 0km" /></label>
        <label>Premio<input name="prize" required placeholder="Moto 0km marca X" /></label>
        <label>Slug<input name="slug" required placeholder="sorteo-moto-2026" pattern="[a-z0-9]+(-[a-z0-9]+)*" /></label>
        <label>Precio por número (COP)<input name="price" type="number" min="0" value="10000" required /></label>
        <label>Número mínimo<input name="min" type="number" min="0" value="1" required /></label>
        <label>Número máximo<input name="max" type="number" min="0" value="999" required /></label>
        <label>Mínimo para sortear<input name="minSold" type="number" min="0" value="20" /></label>
        <label>Descripción<input name="description" placeholder="Opcional" /></label>
        <label>Cierre de ventas<input name="endsAt" type="datetime-local" required value="${esc(fechaPorDefecto(30))}" /></label>
        <label>Fecha del sorteo<input name="drawAt" type="datetime-local" value="${esc(fechaPorDefecto(30))}" /></label>
        <div class="form-actions"><button type="submit" class="btn-approve">Crear rifa</button></div>
      </form>
    </section>`;

  el.querySelectorAll("[data-sel]").forEach((b) => {
    b.onclick = () => { cfg.raffleSlug = b.dataset.sel; saveCfg(cfg); toast(`Rifa activa: ${b.dataset.sel}`); render(); };
  });

  el.querySelectorAll("[data-pub]").forEach((b) => {
    b.onclick = async () => {
      const previo = b.textContent;
      b.disabled = true; b.textContent = "Publicando…";
      try {
        const r = await api(`/api/raffles/${b.dataset.pub}/publish`, { method: "POST" });
        toast(`Publicado en ${r.repo}`);
        // Se repinta la vista en vez de parchear el DOM a mano: el backend ya
        // guardo publishedAt, asi que al releer sale el estado de verdad y
        // sobrevive a la siguiente recarga.
        render();
      } catch (e) {
        toast(e.message, false);
        b.disabled = false; b.textContent = previo;
      }
    };
  });

  el.querySelectorAll("[data-premio]").forEach((b) => {
    b.onclick = () => abrirEditorPremio(b.dataset.premio);
  });

  $("#form-rifa").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const slug = f.slug.value.trim();
    const body = {
      slug,
      title: f.title.value.trim(),
      prize: f.prize.value.trim(),
      description: f.description.value.trim(),
      priceCents: Math.round(Number(f.price.value) * 100),
      numberRange: { min: Number(f.min.value), max: Number(f.max.value) },
      minSoldToDraw: Number(f.minSold.value || 0),
      endsAt: localAIso(f.endsAt.value),
      drawAt: localAIso(f.drawAt.value),
    };
    try {
      await api("/api/raffles", { method: "POST", body });
      cfg.raffleSlug = slug; saveCfg(cfg);
      toast(`Rifa "${body.title}" creada`);
      await render();
      // Las fotos se commitean al repo de la rifa, y ese repo lo crea la
      // publicacion que acaba de ocurrir. Por eso el premio se monta DESPUES de
      // crear y no en este formulario: antes no habria donde subirlas.
      abrirEditorPremio(slug);
    } catch (err) {
      toast(err.message, false);
    }
  };
};

// --------------------------- Editor de premio ---------------------------
//
// Monta la "vitrina" de la rifa: portada, galeria, video, desglose de items con
// su valor y color de acento. Todo esto viaja a raffle.json y de ahi lo lee la
// web publica.

const ACENTOS = [
  ["#8b5cf6", "Violeta"], ["#f5c518", "Oro"], ["#34d058", "Verde"],
  ["#ff3b46", "Rojo"], ["#0ea5e9", "Azul"], ["#ec4899", "Magenta"],
];

/**
 * Reduce la imagen ANTES de subirla.
 *
 * Una foto de celular son 4-8 MB. Vercel corta el cuerpo de la peticion en
 * ~4,5 MB y base64 infla un 33%, asi que subirla cruda falla con un error que no
 * dice nada. Ademas quedaria commiteada para siempre en el repo publico. 1600 px
 * de ancho es de sobra para una web y deja el archivo en ~200-400 KB.
 *
 * Se usa canvas (esto es un webview) para no meter dependencias en Tauri.
 */
function reducirImagen(file, maxLado = 1600, calidad = 0.82) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("No se pudo leer el archivo"));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("El archivo no es una imagen válida"));
      img.onload = () => {
        const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
        const w = Math.round(img.width * escala);
        const h = Math.round(img.height * escala);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        // Un PNG con transparencia sobre canvas vacio se vuelve negro al pasar a
        // JPEG: se pinta blanco debajo primero.
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", calidad));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

/** Sube una imagen al repo de la rifa y devuelve su URL raw. */
async function subirImagen(slug, file) {
  const base64 = await reducirImagen(file);
  const r = await api(`/api/raffles/${slug}/media`, { method: "POST", body: { base64 } });
  return r.url;
}

let premioEstado = null; // { slug, media, prizeItems, theme }

/** ISO -> valor para <input type="datetime-local"> en hora LOCAL del admin. */
function isoALocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  // toISOString() daria UTC y el admin veria una hora corrida (Colombia = -5).
  // Se resta el desfase para que el input muestre la hora que el humano espera.
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

/** Valor de <input type="datetime-local"> (hora local) -> ISO con zona. */
const localAIso = (v) => (v ? new Date(v).toISOString() : null);

async function abrirEditorPremio(slug) {
  try {
    // Los medios de pago NO estan en raffle.json (no se publican): se piden aparte.
    const [raffle, pago] = await Promise.all([
      api(`/api/raffles/${slug}/public/raffle.json`),
      api(`/api/raffles/${slug}/payment`),
    ]);
    premioEstado = {
      slug,
      media: { cover: raffle.media?.cover || "", gallery: raffle.media?.gallery || [], youtubeId: raffle.media?.youtubeId || "" },
      prizeItems: (raffle.prizeItems || []).map((i) => ({ ...i })),
      theme: { accent: raffle.theme?.accent || "" },
      endsAt: raffle.endsAt || "",
      drawAt: raffle.drawAt || "",
      minSoldToDraw: raffle.minSoldToDraw ?? 0,
      paymentMethods: (pago.paymentMethods || []).map((m) => ({ ...m })),
      gatewayEnabled: pago.gatewayEnabled !== false,
      manualEnabled: pago.manualEnabled !== false,
    };
    pintarEditorPremio();
  } catch (e) {
    toast(e.message, false);
  }
}

function cerrarEditorPremio() {
  premioEstado = null;
  $("#modal").innerHTML = "";
  $("#modal").classList.remove("show");
}

function pintarEditorPremio() {
  const s = premioEstado;
  if (!s) return;
  const total = s.prizeItems.reduce((a, i) => a + Number(i.valueCents || 0), 0);
  const m = $("#modal");
  m.classList.add("show");
  m.innerHTML = `
    <div class="modal-card">
      <header class="modal-head">
        <div>
          <h2>Premio y fotos</h2>
          <p class="muted small">${esc(s.slug)} · así se verá en la web pública</p>
        </div>
        <button class="btn-link" id="pm-cerrar">Cerrar</button>
      </header>

      <div class="modal-body">
        <h3>Fechas</h3>
        <p class="muted small">
          Las ventas cierran y la lotería juega después: son dos fechas distintas.
          Si no se vende el mínimo, aplaza el sorteo cambiando la fecha aquí.
        </p>
        <div class="fechas-grid">
          <label>Cierre de ventas
            <input type="datetime-local" class="inp" id="pm-ends" value="${esc(isoALocal(s.endsAt))}" />
          </label>
          <label>Fecha del sorteo
            <input type="datetime-local" class="inp" id="pm-draw" value="${esc(isoALocal(s.drawAt))}" />
          </label>
          <label>Mínimo para sortear
            <input type="number" min="0" class="inp" id="pm-minsold" value="${Number(s.minSoldToDraw) || 0}" />
          </label>
        </div>

        <h3>Cómo se paga</h3>
        <p class="muted small">Si apagas los dos, nadie podrá comprar números.</p>
        <div class="switches">
          <label class="check">
            <input type="checkbox" id="pm-gw" ${s.gatewayEnabled ? "checked" : ""} />
            Pasarela de pagos (Wompi) — cobro automático
          </label>
          <label class="check">
            <input type="checkbox" id="pm-mn" ${s.manualEnabled ? "checked" : ""} />
            Pagos manuales — el comprador sube el comprobante y tú lo verificas
          </label>
        </div>

        <h3>Medios de pago manual</h3>
        <p class="muted small">
          Lo que el comprador ve y copia para pagarte. <b>No se publican en GitHub</b>:
          el historial es público y permanente, así que una cuenta ahí quedaría para
          siempre. Se los entrega el backend a quien va a comprar.
        </p>
        <div class="pagos-edit">
          ${s.paymentMethods.map((m, i) => `
            <div class="pago-edit">
              <input class="inp" data-plabel="${i}" placeholder="Nequi" value="${esc(m.label)}" />
              <input class="inp" data-pvalue="${i}" placeholder="3200000000" value="${esc(m.value)}" />
              <input class="inp" data-phint="${i}" placeholder="A nombre de… (opcional)" value="${esc(m.hint || "")}" />
              <button class="btn-reject" data-pdel="${i}">Quitar</button>
            </div>`).join("")}
          ${s.paymentMethods.length === 0 ? `<p class="muted small">Sin medios de pago. Añade al menos uno si aceptas pagos manuales.</p>` : ""}
        </div>
        <button class="btn-secondary" id="pm-addpago">+ Añadir medio de pago</button>

        <h3>Portada</h3>
        <p class="muted small">Imagen grande de la rifa. Se usa también al compartir el enlace por WhatsApp.</p>
        <div class="media-row">
          ${s.media.cover ? `<div class="thumb"><img src="${esc(s.media.cover)}" alt="" /><button class="thumb-x" id="pm-cover-x">✕</button></div>` : ""}
          <label class="drop">
            <input type="file" accept="image/*" id="pm-cover" hidden />
            <span>${s.media.cover ? "Cambiar portada" : "+ Subir portada"}</span>
          </label>
        </div>

        <h3>Galería</h3>
        <p class="muted small">Hasta 12 fotos del premio.</p>
        <div class="media-row">
          ${s.media.gallery.map((u, i) => `
            <div class="thumb"><img src="${esc(u)}" alt="" /><button class="thumb-x" data-gx="${i}">✕</button></div>`).join("")}
          ${s.media.gallery.length < 12 ? `
            <label class="drop">
              <input type="file" accept="image/*" id="pm-gal" hidden multiple />
              <span>+ Añadir fotos</span>
            </label>` : ""}
        </div>

        <h3>Video de YouTube</h3>
        <p class="muted small">Pega la URL del video. Opcional.</p>
        <input class="inp" id="pm-yt" placeholder="https://www.youtube.com/watch?v=..."
               value="${esc(s.media.youtubeId ? `https://www.youtube.com/watch?v=${s.media.youtubeId}` : "")}" />

        <h3>Color de la rifa</h3>
        <p class="muted small">El acento de su página. Cada rifa puede tener el suyo.</p>
        <div class="acentos">
          ${ACENTOS.map(([hex, nom]) => `
            <button class="acento ${(s.theme.accent || "#8b5cf6") === hex ? "on" : ""}"
                    data-acc="${hex}" style="background:${hex}" title="${nom}"></button>`).join("")}
        </div>

        <h3>¿Qué se gana? · ${s.prizeItems.length} ${s.prizeItems.length === 1 ? "ítem" : "ítems"}</h3>
        <p class="muted small">
          El premio puede ser una cosa o muchas. El valor total se calcula solo:
          <b>${copFormat(total)}</b>
        </p>
        <div class="items-edit">
          ${s.prizeItems.map((it, i) => `
            <div class="item-edit">
              <div class="item-edit-img">
                ${it.imageUrl ? `<img src="${esc(it.imageUrl)}" alt="" />` : `<span class="muted small">Sin foto</span>`}
                <label class="mini">
                  <input type="file" accept="image/*" data-iimg="${i}" hidden />
                  <span>${it.imageUrl ? "Cambiar" : "Foto"}</span>
                </label>
              </div>
              <div class="item-edit-campos">
                <input class="inp" data-iname="${i}" placeholder="Qué es (ej: Microscopio SVA-75)" value="${esc(it.name)}" />
                <input class="inp" data-idesc="${i}" placeholder="Descripción (opcional)" value="${esc(it.description || "")}" />
                <div class="item-edit-fila">
                  <input class="inp" data-ival="${i}" type="number" min="0" step="1000"
                         placeholder="Valor en COP" value="${it.valueCents ? it.valueCents / 100 : ""}" />
                  <label class="check">
                    <input type="checkbox" data-ifeat="${i}" ${it.featured ? "checked" : ""} /> Destacado
                  </label>
                  <button class="btn-reject" data-idel="${i}">Quitar</button>
                </div>
              </div>
            </div>`).join("")}
        </div>
        <button class="btn-secondary" id="pm-add">+ Añadir ítem al premio</button>
      </div>

      <footer class="modal-foot">
        <button class="btn-link" id="pm-cancel">Cancelar</button>
        <button class="btn-approve" id="pm-save">Guardar y publicar</button>
      </footer>
    </div>`;

  // ---- Enlaces de la UI al estado. Se relee del DOM al guardar, asi que aqui
  // ---- solo se atienden las acciones que cambian la estructura.
  $("#pm-cerrar").onclick = cerrarEditorPremio;
  $("#pm-cancel").onclick = cerrarEditorPremio;

  $("#pm-add").onclick = () => {
    volcarCampos();
    s.prizeItems.push({ name: "", description: "", valueCents: 0, imageUrl: "", featured: false });
    pintarEditorPremio();
  };

  $("#pm-addpago").onclick = () => {
    volcarCampos();
    s.paymentMethods.push({ label: "", value: "", hint: "" });
    pintarEditorPremio();
  };

  m.querySelectorAll("[data-pdel]").forEach((b) => {
    b.onclick = () => {
      volcarCampos();
      s.paymentMethods.splice(Number(b.dataset.pdel), 1);
      pintarEditorPremio();
    };
  });

  m.querySelectorAll("[data-idel]").forEach((b) => {
    b.onclick = () => {
      volcarCampos();
      s.prizeItems.splice(Number(b.dataset.idel), 1);
      pintarEditorPremio();
    };
  });

  m.querySelectorAll("[data-acc]").forEach((b) => {
    b.onclick = () => { volcarCampos(); s.theme.accent = b.dataset.acc; pintarEditorPremio(); };
  });

  const conSubida = async (input, fn) => {
    const file = input.files?.[0];
    if (!file) return;
    volcarCampos();
    toast("Subiendo imagen…");
    try {
      const url = await subirImagen(s.slug, file);
      fn(url);
      pintarEditorPremio();
      toast("Imagen subida");
    } catch (e) {
      toast(e.message, false);
    }
  };

  $("#pm-cover")?.addEventListener("change", (e) => conSubida(e.target, (u) => { s.media.cover = u; }));
  $("#pm-cover-x") && ($("#pm-cover-x").onclick = () => { volcarCampos(); s.media.cover = ""; pintarEditorPremio(); });

  $("#pm-gal")?.addEventListener("change", async (e) => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    volcarCampos();
    toast(`Subiendo ${files.length} imagen(es)…`);
    try {
      for (const f of files) {
        if (s.media.gallery.length >= 12) break;
        s.media.gallery.push(await subirImagen(s.slug, f));
      }
      pintarEditorPremio();
      toast("Galería actualizada");
    } catch (err) {
      toast(err.message, false);
    }
  });

  m.querySelectorAll("[data-gx]").forEach((b) => {
    b.onclick = () => { volcarCampos(); s.media.gallery.splice(Number(b.dataset.gx), 1); pintarEditorPremio(); };
  });

  m.querySelectorAll("[data-iimg]").forEach((inp) => {
    inp.addEventListener("change", (e) => {
      const i = Number(inp.dataset.iimg);
      conSubida(e.target, (u) => { s.prizeItems[i].imageUrl = u; });
    });
  });

  $("#pm-save").onclick = guardarPremio;
}

/**
 * Lee los inputs al estado antes de repintar.
 *
 * El editor se repinta entero en cada cambio estructural (añadir/quitar item).
 * Sin volcar antes, lo que el usuario acababa de teclear se perderia al repintar.
 */
function volcarCampos() {
  const s = premioEstado;
  if (!s || !$("#modal").classList.contains("show")) return;
  const m = $("#modal");
  m.querySelectorAll("[data-iname]").forEach((i) => { s.prizeItems[Number(i.dataset.iname)].name = i.value; });
  m.querySelectorAll("[data-idesc]").forEach((i) => { s.prizeItems[Number(i.dataset.idesc)].description = i.value; });
  m.querySelectorAll("[data-ival]").forEach((i) => {
    // El admin teclea pesos; el backend exige centavos ENTEROS. Math.round evita
    // que 19999.999 (coma flotante) llegue como decimal y lo rechace la API.
    s.prizeItems[Number(i.dataset.ival)].valueCents = Math.round(Number(i.value || 0) * 100);
  });
  m.querySelectorAll("[data-ifeat]").forEach((i) => { s.prizeItems[Number(i.dataset.ifeat)].featured = i.checked; });
  m.querySelectorAll("[data-plabel]").forEach((i) => { s.paymentMethods[Number(i.dataset.plabel)].label = i.value; });
  m.querySelectorAll("[data-pvalue]").forEach((i) => { s.paymentMethods[Number(i.dataset.pvalue)].value = i.value; });
  m.querySelectorAll("[data-phint]").forEach((i) => { s.paymentMethods[Number(i.dataset.phint)].hint = i.value; });
  const yt = $("#pm-yt");
  if (yt) s.media.youtubeId = yt.value.trim();
  const ends = $("#pm-ends"); if (ends) s.endsAt = localAIso(ends.value);
  const draw = $("#pm-draw"); if (draw) s.drawAt = localAIso(draw.value);
  const ms = $("#pm-minsold"); if (ms) s.minSoldToDraw = Number(ms.value || 0);
  const gw = $("#pm-gw"); if (gw) s.gatewayEnabled = gw.checked;
  const mn = $("#pm-mn"); if (mn) s.manualEnabled = mn.checked;
}

async function guardarPremio() {
  volcarCampos();
  const s = premioEstado;
  const pagos = s.paymentMethods.filter((m) => m.label.trim() && m.value.trim());

  // Avisos ANTES de guardar: son configuraciones validas para el backend pero que
  // dejan la rifa sin poder venderse. Mejor detenerlo aqui que descubrirlo cuando
  // un comprador no pueda pagar.
  if (!s.gatewayEnabled && !s.manualEnabled) {
    toast("Con los dos métodos apagados nadie podrá comprar números.", false);
    return;
  }
  if (s.manualEnabled && pagos.length === 0) {
    toast("Aceptas pagos manuales pero no hay ningún medio de pago: el comprador no sabría a dónde pagarte.", false);
    return;
  }

  const b = $("#pm-save");
  b.disabled = true; b.textContent = "Guardando…";
  try {
    const items = s.prizeItems.filter((i) => i.name.trim());
    await api(`/api/raffles/${s.slug}`, {
      method: "PATCH",
      body: {
        media: {
          cover: s.media.cover || undefined,
          gallery: s.media.gallery,
          // Se manda la URL entera: el backend extrae el id de 11 caracteres.
          youtubeId: s.media.youtubeId || undefined,
        },
        prizeItems: items,
        theme: s.theme.accent ? { accent: s.theme.accent } : {},
        endsAt: s.endsAt || undefined,
        drawAt: s.drawAt,
        minSoldToDraw: s.minSoldToDraw,
        paymentMethods: pagos,
        gatewayEnabled: s.gatewayEnabled,
        manualEnabled: s.manualEnabled,
      },
    });
    toast("Guardado y publicado");
    cerrarEditorPremio();
    render();
  } catch (e) {
    toast(e.message, false);
    b.disabled = false; b.textContent = "Guardar y publicar";
  }
}

// --------------------------- Vista: Comprobantes ---------------------------
let comprobantesTab = "PENDING";

/**
 * Muestra el pantallazo del pago.
 *
 * No se puede poner la URL en un <img src>: el endpoint exige el token y un <img>
 * no manda cabeceras. Se descarga autenticado y se pinta desde un blob local,
 * que ademas evita que la imagen quede en la cache del webview.
 */
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
        <header class="modal-head">
          <div>
            <h2>Comprobante del pago</h2>
            <p class="muted small">Dato privado: no se publica ni sale del panel.</p>
          </div>
          <button class="btn-link" id="rc-cerrar">Cerrar</button>
        </header>
        <div class="modal-body" style="text-align:center">
          <img src="${url}" alt="Comprobante del pago" class="receipt-img" />
        </div>
      </div>`;
    const cerrar = () => {
      // Liberar el blob: si no, la imagen se queda en memoria toda la sesion.
      URL.revokeObjectURL(url);
      m.innerHTML = ""; m.classList.remove("show");
    };
    $("#rc-cerrar").onclick = cerrar;
    m.onclick = (e) => { if (e.target === m) cerrar(); };
  } catch (e) {
    if (url) URL.revokeObjectURL(url);
    m.innerHTML = ""; m.classList.remove("show");
    toast(e.message, false);
  }
}

VIEWS.comprobantes = async (el) => {
  await checkHealth();
  if (!backendOnline) { el.innerHTML = backendBanner(); return; }
  const [{ purchases }, raffles, raffle] = await Promise.all([
    api(`/api/raffles/${cfg.raffleSlug}/purchases?status=${comprobantesTab}`),
    api("/api/raffles"),
    api(`/api/raffles/${cfg.raffleSlug}/public/raffle.json`),
  ]);
  const max = raffles.raffles.find((r) => r.slug === cfg.raffleSlug)?.numberRange?.max ?? 0;
  const esPend = comprobantesTab === "PENDING";

  // El ganador de PRIMERO: cuando hay cientos de vendidos, buscarlo a mano en la
  // lista es absurdo. Es el unico registro que el administrador va a querer ver.
  const numGanador = raffle.winner?.number ?? null;
  const lista = [...purchases].sort((a, b) => {
    if (a.number === numGanador) return -1;
    if (b.number === numGanador) return 1;
    // Los que ya mandaron comprobante van antes: son los que esperan respuesta.
    if (esPend && a.hasReceipt !== b.hasReceipt) return a.hasReceipt ? -1 : 1;
    return new Date(a.purchasedAt) - new Date(b.purchasedAt);
  });

  el.innerHTML = `
    <header class="topbar"><div><h1>Comprobantes</h1><p class="muted">${esc(cfg.raffleSlug)}</p></div></header>
    <section class="panel">
      <div class="tabs">
        <button class="tab ${esPend ? "tab-on" : ""}" data-tab="PENDING">Pendientes</button>
        <button class="tab ${esPend ? "" : "tab-on"}" data-tab="APPROVED">Vendidos</button>
      </div>
      <p class="muted small">${esPend
        ? "La imagen del comprobante es de acceso privado (nunca pública). Aprobar marca el número como vendido y publica el estado público."
        : "Anular libera el número y lo quita del estado público. <b>No devuelve el dinero</b>: si se pagó con Wompi, la devolución se hace en su panel."}</p>
      <ul class="approvals">
        ${lista.length === 0 ? `<li class="muted">${esPend ? "No hay comprobantes pendientes. 🎉" : "Aún no hay números vendidos."}</li>` : ""}
        ${lista.map((p) => {
          const esGanador = p.number === numGanador;
          return `
          <li class="approval ${esGanador ? "ganador" : ""}" data-id="${esc(p.id)}">
            <div>
              <div class="who">
                ${esGanador ? `<span class="badge-win">🏆 GANADOR</span> ` : ""}
                ${esc(p.buyer)} · Número ${padNum(p.number, max)}
              </div>
              <div class="meta">${esc(p.method)} · ${p.contact?.phone ? esc(p.contact.phone) : "sin teléfono"} · ${new Date(p.purchasedAt).toLocaleString("es-CO")}</div>
              ${p.hasReceipt
                ? `<button class="btn-link" data-receipt="${esc(p.id)}">🧾 Ver comprobante del pago</button>`
                : p.method === "MANUAL" ? `<div class="meta">⏳ Sin comprobante todavía</div>` : ""}
            </div>
            <div class="actions">
              ${esGanador
                // No se ofrece anular al ganador: el backend lo rechaza igual
                // (dejaria draw.json apuntando a un numero sin vender), asi que
                // el boton solo serviria para dar un error.
                ? `<span class="win-nota">Ganador declarado<br/><span class="muted small">no se puede anular</span></span>`
                : esPend ? `
                <button class="btn-approve" data-approve="${esc(p.id)}">Aprobar</button>
                <button class="btn-reject" data-reject="${esc(p.id)}">Rechazar</button>
              ` : `
                <button class="btn-reject" data-void="${esc(p.id)}" data-num="${padNum(p.number, max)}">Anular venta</button>
              `}
            </div>
          </li>`;
        }).join("")}
      </ul>
    </section>`;

  el.querySelectorAll("[data-tab]").forEach((b) => {
    b.onclick = () => { comprobantesTab = b.dataset.tab; render(); };
  });

  el.querySelectorAll("[data-receipt]").forEach((b) => {
    b.onclick = () => verComprobante(b.dataset.receipt);
  });

  el.querySelectorAll("[data-void]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`¿Anular la venta del número ${b.dataset.num}?\n\nEl número volverá a estar libre y saldrá del estado público.\nOJO: esto NO devuelve el dinero.`)) return;
      try {
        const r = await api(`/api/purchases/${b.dataset.void}/void`, {
          method: "POST", body: { reason: "Anulada por el administrador" },
        });
        toast(r.avisoReembolso || `Venta anulada · número ${b.dataset.num} liberado`, !r.avisoReembolso);
        render();
      } catch (e) { toast(e.message, false); }
    };
  });

  el.querySelectorAll("[data-approve]").forEach((b) => {
    b.onclick = async () => {
      try { await api(`/api/purchases/${b.dataset.approve}/approve`, { method: "POST", body: { approvedBy: "admin" } });
        toast("Comprobante aprobado · número vendido"); render();
      } catch (e) { toast(e.message, false); }
    };
  });
  el.querySelectorAll("[data-reject]").forEach((b) => {
    b.onclick = async () => {
      // WebView2 no soporta prompt(); usamos confirm() con motivo por defecto.
      if (!confirm("¿Rechazar este comprobante? El número volverá a quedar libre.")) return;
      try { await api(`/api/purchases/${b.dataset.reject}/reject`, { method: "POST", body: { reason: "Rechazado por el administrador" } });
        toast("Comprobante rechazado · número liberado"); render();
      } catch (e) { toast(e.message, false); }
    };
  });
};

// --------------------------- Vista: Ganadores ---------------------------
VIEWS.ganadores = async (el) => {
  await checkHealth();
  if (!backendOnline) { el.innerHTML = backendBanner(); return; }
  const raffle = await api(`/api/raffles/${cfg.raffleSlug}/public/raffle.json`);
  const winner = raffle.winner;
  el.innerHTML = `
    <header class="topbar"><div><h1>Ganadores</h1><p class="muted">${esc(cfg.raffleSlug)}</p></div></header>
    ${winner ? `
      <section class="panel winner-panel">
        <h2>🏆 Ganador declarado</h2>
        <div style="font-size:20px;font-weight:700">Número ${padNum(winner.number, raffle.numberRange.max)} — ${esc(winner.buyer)}</div>
        <div class="muted">Verificado: ${new Date(winner.verifiedAt).toLocaleString("es-CO")}</div>
      </section>` : `
      <section class="panel">
        <h2>Declarar ganador</h2>
        <p class="muted small">El número debe estar vendido (pago aprobado). En sorteo aleatorio, el sistema elige entre los vendidos.</p>
        <form id="form-draw" class="form-grid">
          <label>Mecánica
            <select name="mechanism">
              <option value="ADMIN_INPUT">Número ingresado (sorteo externo)</option>
              <option value="RANDOM_FROM_SOLD">Aleatorio entre vendidos</option>
            </select>
          </label>
          <label>Número ganador<input name="number" type="number" min="0" placeholder="(opcional si es aleatorio)" /></label>
          <div class="form-actions"><button type="submit" class="btn-approve">Declarar ganador</button></div>
        </form>
      </section>`}`;

  const form = $("#form-draw");
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const mechanism = form.mechanism.value;
    const numRaw = form.number.value;
    const body = { mechanism };
    if (numRaw !== "") body.number = Number(numRaw);
    try {
      const d = await api(`/api/raffles/${cfg.raffleSlug}/draw`, { method: "POST", body });
      toast(`Ganador: número ${padNum(d.winningNumber, raffle.numberRange.max)}`);
      render();
    } catch (err) { toast(err.message, false); }
  };
};

// --------------------------- Vista: Configuración ---------------------------
VIEWS.config = async (el) => {
  const h = await checkHealth();
  el.innerHTML = `
    <header class="topbar"><div><h1>Configuración</h1><p class="muted">Conexión y preferencias (se guardan en este equipo)</p></div></header>
    <section class="panel">
      <h2>Conexión al backend</h2>
      <form id="form-cfg" class="form-grid">
        <label>URL del backend<input name="backendUrl" value="${esc(cfg.backendUrl)}" placeholder="http://localhost:8787" /></label>
        <label>Rifa activa (slug)<input name="raffleSlug" value="${esc(cfg.raffleSlug)}" /></label>
        <label>Intervalo de actualización (seg)<input name="pollSeconds" type="number" min="0" value="${esc(cfg.pollSeconds)}" /></label>
        <div class="form-actions">
          <button type="submit" class="btn-approve">Guardar</button>
          <button type="button" id="btn-test" class="btn-secondary">Probar conexión</button>
        </div>
      </form>
      <div class="status-line">
        Estado: <b>${backendOnline ? "conectado" : "sin conexión"}</b>
        ${h ? ` · almacenamiento: <b>${esc(h.storage)}</b> · Wompi: <b>${h.wompiConfigured ? "configurado" : "sin llaves"}</b> · GitHub: <b>${h.githubConfigured ? "configurado" : "no configurado"}</b>` : ""}
      </div>
    </section>
    <section class="panel">
      <h2>Seguridad</h2>
      <p class="muted small">
        Por diseño, las llaves de <b>Wompi</b> y el token de <b>GitHub</b> NO se guardan en esta app:
        viven en el archivo <code>.env</code> del backend. Esta app solo se comunica con el backend,
        que es quien tiene los secretos. Ver <code>services/backend/.env</code> y <code>.env.example</code>.
      </p>
    </section>`;

  $("#form-cfg").onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    cfg = { ...cfg, backendUrl: f.backendUrl.value.trim(), raffleSlug: f.raffleSlug.value.trim(), pollSeconds: Number(f.pollSeconds.value || 0) };
    saveCfg(cfg);
    toast("Configuración guardada");
    render();
  };
  $("#btn-test").onclick = async () => {
    // Prueba lo que está ESCRITO, no lo guardado, y sin re-renderizar
    // (render() borraria lo que el usuario acaba de teclear).
    const escrito = $("#form-cfg").backendUrl.value.trim();
    const h = await checkHealth(escrito);
    const linea = $(".status-line");
    if (h) {
      toast(`Conexión exitosa · almacenamiento: ${h.storage}`);
      if (linea) linea.innerHTML = `Estado: <b>conectado</b> · entorno Wompi: <b>${esc(h.env)}</b> · almacenamiento: <b>${esc(h.storage)}</b>`;
    } else {
      toast(`No se pudo conectar a ${escrito}`, false);
      if (linea) linea.innerHTML = `Estado: <b>sin conexión</b> — revisa la URL y pulsa Guardar si la cambiaste.`;
    }
  };
};

// --------------------------- Arranque ---------------------------
async function loadVersion() {
  try { $("#app-version").textContent = await invoke("app_version"); }
  catch { $("#app-version").textContent = "1.0"; }
}

document.querySelectorAll(".nav-item").forEach((b) => {
  b.addEventListener("click", () => setView(b.dataset.view));
});

(async function boot() {
  loadVersion();
  await checkHealth();
  // Si hay un refresh guardado, se restaura la sesion sin pedir la clave.
  const hay = await restaurarSesion();
  setView(hay ? (session.mustEnable2fa ? "seguridad" : "panel") : "login");
  setInterval(checkHealth, 30_000);
})();
