// Lectura del estado publico de las rifas DESDE GITHUB (Guia 8).
//
// A proposito NO se consulta el backend: el sorteo debe poder verificarse aunque
// el backend este caido o se apague. La unica fuente es el repo de cada rifa, que
// ademas conserva el historial de commits (la cronologia auditable).

const OWNER = process.env.RIFFLES_OWNER || "sorteos-jhonsu01";
const BRANCH = process.env.RIFFLES_BRANCH || "main";

// ISR: se regenera cada minuto. Evita pegarle a GitHub en cada visita y respeta
// su limite de peticiones anonimas (60/h por IP).
const REVALIDATE = 60;

const raw = (slug, file) =>
  `https://raw.githubusercontent.com/${OWNER}/${slug}/${BRANCH}/public/${file}`;

async function getJson(url) {
  try {
    const res = await fetch(url, { next: { revalidate: REVALIDATE } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Estado publico completo de una rifa. `raffle` null si el repo no es una rifa. */
export async function getRifa(slug) {
  const [raffle, numbers, draw] = await Promise.all([
    getJson(raw(slug, "raffle.json")),
    getJson(raw(slug, "numbers.json")),
    getJson(raw(slug, "draw.json")),
  ]);
  if (!raffle) return null;
  return {
    slug,
    raffle,
    sold: numbers?.sold ?? [],
    draw,
    repoUrl: `https://github.com/${OWNER}/${slug}`,
  };
}

/**
 * Lista las rifas publicadas: repos de la organizacion que tengan raffle.json.
 * La API publica de GitHub no necesita token para repos publicos.
 */
export async function listRifas() {
  const repos = await getJson(`https://api.github.com/orgs/${OWNER}/repos?per_page=100`);
  if (!Array.isArray(repos)) return [];
  const rifas = await Promise.all(repos.map((r) => getRifa(r.name)));
  // Un repo sin raffle.json no es una rifa: se descarta.
  return rifas.filter(Boolean).sort((a, b) => a.raffle.title.localeCompare(b.raffle.title));
}

export const OWNER_NAME = OWNER;

// --------------------------- Formato ---------------------------
export const copFormat = (cents) =>
  new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 })
    .format((cents || 0) / 100);

/**
 * Numero con ceros a la izquierda: 1 -> "001".
 * El ganador sale de las ultimas 3 cifras de una loteria externa, asi que "001"
 * es un numero DISTINTO de "010". El ancho se deriva del maximo del rango.
 */
export const padNum = (n, max) => String(n).padStart(String(max ?? 0).length, "0");

// --------------------------- Tema por rifa ---------------------------

/** Violeta de la marca: el acento cuando la rifa no define el suyo. */
export const ACCENT_DEFAULT = "#8b5cf6";

/**
 * El acento sale de raffle.json, o sea de la base de datos. Se revalida aqui
 * ademas de en el backend: esto entra en una variable CSS y un valor con texto
 * libre podria escribir CSS arbitrario. La web lee de GitHub, que es publico;
 * no da por bueno lo que venga solo porque venga de "nuestro" JSON.
 */
export function accentOf(raffle) {
  const a = raffle?.theme?.accent;
  return typeof a === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(a) ? a : ACCENT_DEFAULT;
}

/**
 * Color de texto legible SOBRE el acento.
 *
 * Sin esto, un acento oro (#f5c518) con texto blanco es ilegible y un violeta
 * con texto negro tambien. Se decide por luminancia relativa (WCAG), no a ojo:
 * cada organizador elige su color y nadie va a revisar el contraste por el.
 */
export function accentInk(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  // Linealizacion sRGB antes de pesar los canales (WCAG 2.x).
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.45 ? "#0b0b0d" : "#ffffff";
}

// --------------------------- Legal ---------------------------

/** Descargo de responsabilidad. Mismo texto en README, web, APK y admin. */
export const DISCLAIMER =
  "Sorteos y Rifas es software libre, entregado «tal cual», sin garantías. En la mayoría de " +
  "los países las rifas y sorteos están regulados por la ley. La persona u organización que " +
  "crea y opera cada sorteo es la única responsable de cumplir la normativa y obtener los " +
  "permisos de su jurisdicción, de recaudar y administrar los pagos, y de entregar el premio. " +
  "El autor del software no organiza sorteos ni se responsabiliza del uso que terceros den a " +
  "esta herramienta ni de la legalidad de los sorteos creados con ella. Este texto no " +
  "constituye asesoría legal.";

export const KOFI_URL = "https://ko-fi.com/V7V81LV7GX";

export const regimeEs = (r) =>
  ({ REGULADA: "Sorteo regulado", DESCENTRALIZADA: "Sorteo descentralizado" }[r] || null);

export const statusEs = (s) =>
  ({
    ACTIVE: "Activo",
    SALES_CLOSED: "Ventas cerradas",
    DRAWN: "Sorteado",
    POSTPONED: "Pospuesto",
    ARCHIVED: "Archivado",
    DRAFT: "Borrador",
  }[s] || s);
