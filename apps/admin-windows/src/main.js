// Frontend de la App Admin (Tauri v2, withGlobalTauri=true).
// Muestra el panel; los comandos Rust se invocan via window.__TAURI__.core.invoke.

const RAW_BASE =
  "https://raw.githubusercontent.com/jhonsu01/PlataformasSorteosYRifas/main/examples/sorteo-demo/public";

// Datos de respaldo por si el repo aun no esta publicado (primer arranque).
const FALLBACK_RAFFLE = {
  title: "Sorteo Demo — Moto 0km",
  prize: "Moto 0km marca X modelo Y",
  priceCents: 1000000,
  numberRange: { min: 0, max: 99 },
  status: "ACTIVE",
};
const FALLBACK_NUMBERS = { sold: new Array(10).fill(0).map((_, i) => ({ number: i })) };

const APPROVALS = [
  { who: "Juan S.", number: 15, method: "Transferencia", at: "hace 5 min" },
  { who: "María P.", number: 27, method: "Nequi", at: "hace 12 min" },
  { who: "Carlos R.", number: 48, method: "Transferencia", at: "hace 21 min" },
];

function invoke(cmd, args) {
  if (window.__TAURI__ && window.__TAURI__.core) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  return Promise.reject(new Error("Tauri no disponible"));
}

function copFormat(cents) {
  const pesos = (cents || 0) / 100;
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(pesos);
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

async function loadVersion() {
  try {
    const v = await invoke("app_version");
    document.getElementById("app-version").textContent = v;
  } catch {
    document.getElementById("app-version").textContent = "1.0.0";
  }
}

async function loadSummary() {
  try {
    const s = await invoke("dashboard_summary");
    document.getElementById("stat-pending").textContent = s.pendingApprovals ?? APPROVALS.length;
    document.getElementById("stat-sold-today").textContent = s.soldToday ?? 0;
    if (s.backendConnected) {
      const b = document.getElementById("backend-status");
      b.textContent = "Backend conectado";
      b.className = "badge badge-ok";
    }
  } catch {
    document.getElementById("stat-pending").textContent = APPROVALS.length;
    document.getElementById("stat-sold-today").textContent = "0";
  }
}

async function fetchJson(url, fallback) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } catch {
    return fallback;
  }
}

async function loadRaffle() {
  const raffle = await fetchJson(`${RAW_BASE}/raffle.json`, FALLBACK_RAFFLE);
  const numbers = await fetchJson(`${RAW_BASE}/numbers.json`, FALLBACK_NUMBERS);
  const total = raffle.numberRange.max - raffle.numberRange.min + 1;
  const sold = (numbers.sold || []).length;
  const pct = total > 0 ? Math.round((sold / total) * 100) : 0;

  document.getElementById("stat-sold-total").textContent = sold;
  document.getElementById("stat-progress").textContent = pct + "%";
  document.getElementById("progress-bar").style.width = pct + "%";

  document.getElementById("raffle-body").innerHTML = `
    <div style="font-size:18px;font-weight:700;margin-bottom:4px">${raffle.title}</div>
    <div class="kv">
      <div><span class="k">Premio</span><span class="v">${raffle.prize}</span></div>
      <div><span class="k">Precio / número</span><span class="v">${copFormat(raffle.priceCents)}</span></div>
      <div><span class="k">Rango</span><span class="v">${raffle.numberRange.min}–${raffle.numberRange.max}</span></div>
      <div><span class="k">Vendidos</span><span class="v">${sold} de ${total}</span></div>
      <div><span class="k">Estado</span><span class="v">${raffle.status}</span></div>
    </div>`;
}

function renderApprovals() {
  const ul = document.getElementById("approvals");
  ul.innerHTML = "";
  APPROVALS.forEach((a, i) => {
    const li = document.createElement("li");
    li.className = "approval";
    li.innerHTML = `
      <div>
        <div class="who">${a.who} · Número ${a.number}</div>
        <div class="meta">${a.method} · ${a.at}</div>
      </div>
      <div class="actions">
        <button class="btn-approve">Aprobar</button>
        <button class="btn-reject">Rechazar</button>
      </div>`;
    li.querySelector(".btn-approve").onclick = () => {
      li.remove();
      toast(`Aprobado: ${a.who} · Número ${a.number} (demo)`);
    };
    li.querySelector(".btn-reject").onclick = () => {
      li.remove();
      toast(`Rechazado: ${a.who} · Número ${a.number} (demo)`);
    };
    ul.appendChild(li);
  });
}

window.addEventListener("DOMContentLoaded", () => {
  loadVersion();
  loadSummary();
  loadRaffle();
  renderApprovals();
});
