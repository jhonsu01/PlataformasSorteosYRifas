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

// Cliente HTTP hacia el backend.
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(cfg.backendUrl.replace(/\/$/, "") + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let backendOnline = false;
async function checkHealth() {
  const badge = $("#conn-badge");
  try {
    const h = await api("/health");
    backendOnline = true;
    badge.textContent = `● Backend conectado (${h.env})`;
    badge.className = "conn conn-on";
    return h;
  } catch {
    backendOnline = false;
    badge.textContent = "● Backend no conectado";
    badge.className = "conn conn-off";
    return null;
  }
}

// --------------------------- Router ---------------------------
const VIEWS = {};
let current = "panel";

function setView(name) {
  current = name;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  render();
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
  if (backendOnline) return "";
  return `<div class="banner-warn">⚠️ Backend no conectado. Inícialo con <code>cd services/backend &amp;&amp; npm start</code> o ajusta la URL en <b>Configuración</b>.</div>`;
}

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
          <div><span class="k">Rango</span><span class="v">${raffle.numberRange.min}–${raffle.numberRange.max}</span></div>
          <div><span class="k">Vendidos</span><span class="v">${sold} de ${total}</span></div>
          <div><span class="k">Estado</span><span class="v">${esc(raffle.status)}</span></div>
        </div>
        <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
      ` : `<p class="muted">No hay rifa activa.</p>`}
    </section>`;
};

// --------------------------- Vista: Rifas ---------------------------
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
            <div class="rifa-title">${esc(r.title)}</div>
            <div class="muted small">${esc(r.slug)} · ${esc(r.status)}</div>
            <div class="rifa-meta">${r.sold}/${r.total} vendidos · ${copFormat(r.priceCents)}</div>
            <button class="btn-approve" data-sel="${esc(r.slug)}">${r.slug === cfg.raffleSlug ? "Activa" : "Seleccionar"}</button>
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
        <label>Número mínimo<input name="min" type="number" min="0" value="0" required /></label>
        <label>Número máximo<input name="max" type="number" min="0" value="99" required /></label>
        <label>Mínimo para sortear<input name="minSold" type="number" min="0" value="20" /></label>
        <label>Descripción<input name="description" placeholder="Opcional" /></label>
        <div class="form-actions"><button type="submit" class="btn-approve">Crear rifa</button></div>
      </form>
    </section>`;

  el.querySelectorAll("[data-sel]").forEach((b) => {
    b.onclick = () => { cfg.raffleSlug = b.dataset.sel; saveCfg(cfg); toast(`Rifa activa: ${b.dataset.sel}`); render(); };
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
    };
    try {
      await api("/api/raffles", { method: "POST", body });
      cfg.raffleSlug = slug; saveCfg(cfg);
      toast(`Rifa "${body.title}" creada`);
      render();
    } catch (err) {
      toast(err.message, false);
    }
  };
};

// --------------------------- Vista: Comprobantes ---------------------------
VIEWS.comprobantes = async (el) => {
  await checkHealth();
  if (!backendOnline) { el.innerHTML = backendBanner(); return; }
  const { purchases } = await api(`/api/raffles/${cfg.raffleSlug}/purchases?status=PENDING`);
  el.innerHTML = `
    <header class="topbar"><div><h1>Comprobantes</h1><p class="muted">Pendientes de aprobación · ${esc(cfg.raffleSlug)}</p></div></header>
    <section class="panel">
      <p class="muted small">La imagen del comprobante es de acceso privado (nunca pública). Aprobar marca el número como vendido y publica el estado público.</p>
      <ul class="approvals">
        ${purchases.length === 0 ? `<li class="muted">No hay comprobantes pendientes. 🎉</li>` : ""}
        ${purchases.map((p) => `
          <li class="approval" data-id="${esc(p.id)}">
            <div>
              <div class="who">${esc(p.buyer)} · Número ${p.number}</div>
              <div class="meta">${esc(p.method)} · ${p.contact?.phone ? esc(p.contact.phone) : "sin teléfono"} · ${new Date(p.purchasedAt).toLocaleString("es-CO")}</div>
              ${p.receiptUrl ? `<div class="meta">🧾 comprobante adjunto (privado)</div>` : ""}
            </div>
            <div class="actions">
              <button class="btn-approve" data-approve="${esc(p.id)}">Aprobar</button>
              <button class="btn-reject" data-reject="${esc(p.id)}">Rechazar</button>
            </div>
          </li>`).join("")}
      </ul>
    </section>`;

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
        <div style="font-size:20px;font-weight:700">Número ${winner.number} — ${esc(winner.buyer)}</div>
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
      toast(`Ganador: número ${d.winningNumber}`);
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
        ${h ? ` · entorno Wompi: <b>${esc(h.env)}</b> · GitHub: <b>${h.githubConfigured ? "configurado" : "no configurado"}</b>` : ""}
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
    const ok = await checkHealth();
    toast(ok ? "Conexión exitosa" : "No se pudo conectar al backend", Boolean(ok));
    render();
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

loadVersion();
setView("panel");
// Refresco periodico del badge de conexion.
setInterval(checkHealth, 30_000);
