// Normalizacion y validacion del premio "mostrable": fotos, video, desglose de
// items con su valor y color de acento.
//
// Vive aparte porque lo usan LOS DOS stores (memoria y PostgreSQL). Escrito dos
// veces, divergiria, y entonces los tests (que corren contra el store en
// memoria) dejarian de decir nada sobre produccion.
//
// Todo lo de aqui es DETERMINISTICO y puro: mismas entradas -> mismas salidas.
// Es la parte del sistema que toca dinero (el valor del premio que ve el
// comprador), asi que no admite interpretacion.

import { httpError } from "./http-error.js";

export const LIMITES = {
  items: 60,          // la referencia del sector lista ~37; 60 da aire de sobra
  galeria: 12,
  nombre: 120,
  descripcion: 400,
  // 10^12 centavos = $10.000 millones COP. Un premio mayor que eso es un dedo
  // de mas al teclear, no una rifa.
  valorCents: 1_000_000_000_000,
};

const txt = (v, max, campo) => {
  const s = String(v ?? "").trim();
  if (s.length > max) throw httpError(400, `${campo}: maximo ${max} caracteres`);
  return s;
};

/**
 * URL de imagen. Solo https.
 *
 * No es purismo: estas URLs se renderizan en el admin (que arma HTML con
 * plantillas) y viajan al JSON publico. Aceptar `javascript:` o `data:` seria
 * abrir un vector de XSS por un campo de formulario.
 */
export function normalizeImageUrl(v, campo = "imageUrl") {
  const s = String(v ?? "").trim();
  if (!s) return "";
  let u;
  try {
    u = new URL(s);
  } catch {
    throw httpError(400, `${campo}: URL invalida`);
  }
  if (u.protocol !== "https:") throw httpError(400, `${campo}: solo se aceptan URLs https`);
  return u.toString();
}

/**
 * Extrae el id de 11 caracteres de una URL de YouTube.
 *
 * Se guarda el ID, no la URL: asi la web decide como embeberlo (usamos
 * youtube-nocookie) y no queda a merced de que pegaran una URL con parametros
 * de tracking o de lista de reproduccion.
 */
export function youtubeId(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  // Ya es un id pelado.
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw httpError(400, "video: URL de YouTube invalida");
  }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  let id = "";
  if (host === "youtu.be") id = u.pathname.slice(1);
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v") || "";
    else {
      // /embed/ID, /shorts/ID, /live/ID, /v/ID
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]+)/);
      id = m ? m[1] : "";
    }
  }
  if (!/^[\w-]{11}$/.test(id)) throw httpError(400, "video: no parece una URL de YouTube");
  return id;
}

/**
 * Color de acento. SOLO hex.
 *
 * Este valor termina en una variable CSS de la web publica. Aceptar texto libre
 * seria dejar que el contenido de la base escriba CSS (`red; background: url(...)`).
 * Un hex no puede escapar de su propio valor.
 */
export function normalizeAccent(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s)) {
    throw httpError(400, "theme.accent: debe ser un color hex (#f5c518)");
  }
  return s.toLowerCase();
}

export function normalizeTheme(v) {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw httpError(400, "theme: debe ser un objeto");
  const accent = normalizeAccent(v.accent);
  return accent ? { accent } : {};
}

/** Un item del premio: que es, cuanto vale y (opcional) su foto. */
function normalizeItem(raw, i) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw httpError(400, `prizeItems[${i}]: debe ser un objeto`);
  }
  const name = txt(raw.name, LIMITES.nombre, `prizeItems[${i}].name`);
  if (!name) throw httpError(400, `prizeItems[${i}].name: requerido`);

  // El valor es dinero: entero, en centavos, nunca negativo. Number.isInteger
  // rechaza "100.5", NaN e Infinity de una sola vez.
  const valueCents = Number(raw.valueCents ?? 0);
  if (!Number.isInteger(valueCents) || valueCents < 0) {
    throw httpError(400, `prizeItems[${i}].valueCents: entero en centavos, >= 0`);
  }
  if (valueCents > LIMITES.valorCents) {
    throw httpError(400, `prizeItems[${i}].valueCents: valor fuera de rango`);
  }
  return {
    name,
    description: txt(raw.description, LIMITES.descripcion, `prizeItems[${i}].description`),
    valueCents,
    imageUrl: normalizeImageUrl(raw.imageUrl, `prizeItems[${i}].imageUrl`),
    // Destacado: sale grande arriba en vez de en la lista larga.
    featured: Boolean(raw.featured),
  };
}

export function normalizePrizeItems(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw httpError(400, "prizeItems: debe ser una lista");
  if (v.length > LIMITES.items) throw httpError(400, `prizeItems: maximo ${LIMITES.items} items`);
  return v.map(normalizeItem);
}

export function normalizeMedia(v) {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw httpError(400, "media: debe ser un objeto");

  const gallery = v.gallery == null ? [] : v.gallery;
  if (!Array.isArray(gallery)) throw httpError(400, "media.gallery: debe ser una lista");
  if (gallery.length > LIMITES.galeria) {
    throw httpError(400, `media.gallery: maximo ${LIMITES.galeria} imagenes`);
  }

  const out = {};
  const cover = normalizeImageUrl(v.cover, "media.cover");
  if (cover) out.cover = cover;

  const g = gallery.map((u, i) => normalizeImageUrl(u, `media.gallery[${i}]`)).filter(Boolean);
  if (g.length) out.gallery = g;

  // Acepta URL completa o id; guarda siempre el id.
  const yt = youtubeId(v.youtubeId ?? v.youtubeUrl ?? v.video);
  if (yt) out.youtubeId = yt;

  return out;
}

/**
 * Valor total del premio = suma de los items. NO se almacena.
 *
 * Un total guardado se desincroniza del desglose en cuanto alguien edita un
 * item, y el comprador ve un total que no cuadra con la lista que tiene debajo.
 * Calcularlo siempre hace imposible esa mentira.
 */
export function prizeTotalCents(items) {
  return (items || []).reduce((acc, it) => acc + Number(it.valueCents || 0), 0);
}
