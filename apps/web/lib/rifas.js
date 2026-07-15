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

export const statusEs = (s) =>
  ({
    ACTIVE: "Activo",
    SALES_CLOSED: "Ventas cerradas",
    DRAWN: "Sorteado",
    POSTPONED: "Pospuesto",
    ARCHIVED: "Archivado",
    DRAFT: "Borrador",
  }[s] || s);
