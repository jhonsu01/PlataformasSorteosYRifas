// Publicador del estado publico a GitHub (Guia 8: "GitHub como fuente de verdad
// publica"). Cada rifa vive en su propio repo <owner>/<slug> y cada cambio queda
// como un COMMIT: el historial es la cronologia inmutable y auditable del sorteo.
//
// Solo se escribe el JSON privacy-safe derivado por el store. Gated: sin token+owner
// no publica (modo demo) y el backend sigue sirviendo el JSON por su propia API.

import crypto from "node:crypto";
import { config, isGithubConfigured } from "./config.js";
import { httpError } from "./http-error.js";

const GITHUB_API = "https://api.github.com";

function gh(path, { method = "GET", body } = {}) {
  return fetch(GITHUB_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${config.github.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "sorteos-rifas-backend",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const README = (raffle) => `# ${raffle.title}

Estado **público** de este sorteo. Publicado automáticamente por el backend del
framework [Sorteos y Rifas](https://github.com/jhonsu01/PlataformasSorteosYRifas).

| | |
| --- | --- |
| Premio | ${raffle.prize} |
| Precio por número | ${(raffle.priceCents / 100).toLocaleString("es-CO")} ${raffle.currency} |
| Rango | ${raffle.numberRange.min}–${raffle.numberRange.max} |

## Archivos

- \`public/raffle.json\` — configuración del sorteo.
- \`public/numbers.json\` — números vendidos.
- \`public/draw.json\` — ganador (cuando se declara).

## Transparencia

Cada venta y la declaración del ganador quedan como un **commit**. El historial de
este repositorio es la cronología completa y verificable del sorteo: nadie puede
reescribir el pasado sin que quede rastro.

## Privacidad

Por diseño aquí **solo** se publica, por número vendido: nombre + inicial del
apellido, el número y las marcas de tiempo de compra y verificación.
Nunca se publica documento, teléfono, correo, dirección ni el comprobante de pago.
`;

/** ¿El owner configurado es una organizacion o una cuenta personal? */
async function ownerIsOrg(owner) {
  const r = await gh(`/users/${owner}`);
  if (!r.ok) throw new Error(`No se pudo leer el owner "${owner}": HTTP ${r.status}`);
  return (await r.json()).type === "Organization";
}

/** Crea el repo de la rifa si no existe. Devuelve true si lo acaba de crear. */
async function ensureRepo(slug, raffle) {
  const owner = config.github.owner;
  const existe = await gh(`/repos/${owner}/${slug}`);
  if (existe.ok) return false;
  if (existe.status !== 404) {
    throw new Error(`Error consultando ${owner}/${slug}: HTTP ${existe.status}`);
  }

  const path = (await ownerIsOrg(owner)) ? `/orgs/${owner}/repos` : `/user/repos`;
  const creado = await gh(path, {
    method: "POST",
    body: {
      name: slug,
      description: `Estado publico del sorteo: ${raffle.title}`,
      private: false,        // el sentido es que sea auditable por cualquiera
      auto_init: true,       // crea el commit inicial (rama main)
      has_issues: false,
      has_projects: false,
      has_wiki: false,
    },
  });
  if (!creado.ok) {
    const txt = await creado.text();
    // Causa habitual: un PAT fine-grained no puede CREAR repos. Se dice claro.
    throw new Error(
      `No se pudo crear el repo ${owner}/${slug} (HTTP ${creado.status}). ` +
      `Si el token no tiene permiso para crear repositorios, crea "${slug}" a mano ` +
      `(publico) y el backend solo escribira en el. Detalle: ${txt.slice(0, 200)}`
    );
  }
  return true;
}

/** Crea o actualiza un archivo (bytes crudos) en el repo de la rifa. */
async function putBytes(slug, path, buf, message) {
  const owner = config.github.owner;
  const branch = config.github.branch;
  const url = `/repos/${owner}/${slug}/contents/${path}`;

  // Para ACTUALIZAR hace falta el sha del archivo actual; si no existe, se crea.
  let sha;
  const actual = await gh(`${url}?ref=${branch}`);
  if (actual.ok) sha = (await actual.json()).sha;

  const res = await gh(url, {
    method: "PUT",
    body: {
      message,
      content: buf.toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub PUT ${path} fallo: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()).commit?.sha;
}

/** Crea o actualiza un archivo JSON en el repo de la rifa. */
const putFile = (slug, path, contentObj, message) =>
  putBytes(slug, path, Buffer.from(JSON.stringify(contentObj, null, 2)), message);

// Firmas de archivo reales. No se confia en el content-type ni en la extension
// que manda el cliente: se miran los bytes. Evita que un error del admin (o algo
// peor) meta al repo publico un archivo que no es una imagen.
const FIRMAS = [
  { ext: "jpg",  test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png",  test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: "gif",  test: (b) => b.subarray(0, 4).toString("ascii") === "GIF8" },
  { ext: "webp", test: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
];

// 2,5 MB de imagen cruda.
//
// El techo real no es nuestro: Vercel corta el cuerpo de una funcion serverless
// en ~4,5 MB, y la imagen viaja en base64 dentro del JSON (+33%). 2,5 MB -> ~3,4 MB
// de base64, que pasa con margen. Poner 5 MB seria mentir: Vercel lo rechazaria
// antes de llegar aqui y el admin veria un error opaco imposible de diagnosticar.
// De todos modos el admin redimensiona antes de subir (~200-400 KB tipico).
export const MAX_IMAGEN_BYTES = 2_500_000;

/**
 * Sube una imagen al repo publico de la rifa y devuelve su URL raw.
 *
 * El nombre es el hash del contenido: subir dos veces la misma foto no genera un
 * commit nuevo (mismo sha -> mismo path -> GitHub no cambia nada), y una foto
 * distinta nunca pisa a otra. Sin esto, "portada.jpg" se sobrescribiria y las
 * rifas viejas cambiarian de imagen sola.
 */
export async function uploadImage(slug, buf) {
  if (!isGithubConfigured()) {
    throw httpError(503, "GitHub no configurado: no hay donde guardar la imagen (modo demo)");
  }
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw httpError(400, "Imagen vacia");
  if (buf.length > MAX_IMAGEN_BYTES) {
    throw httpError(413, `Imagen demasiado grande (maximo ${(MAX_IMAGEN_BYTES / 1e6).toFixed(1)} MB)`);
  }
  const firma = FIRMAS.find((f) => f.test(buf));
  if (!firma) throw httpError(400, "El archivo no es una imagen (JPG, PNG, GIF o WEBP)");

  const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
  const path = `public/media/${hash}.${firma.ext}`;
  await putBytes(slug, path, buf, `chore: imagen ${hash}.${firma.ext}`);
  return {
    url: `https://raw.githubusercontent.com/${config.github.owner}/${slug}/${config.github.branch}/${path}`,
    path,
    bytes: buf.length,
  };
}

/** Crea el README solo al crear el repo (no se pisa despues). */
async function putReadme(slug, raffle) {
  const owner = config.github.owner;
  const url = `/repos/${owner}/${slug}/contents/README.md`;
  const actual = await gh(`${url}?ref=${config.github.branch}`);
  const sha = actual.ok ? (await actual.json()).sha : undefined;
  await gh(url, {
    method: "PUT",
    body: {
      message: "docs: estado publico del sorteo",
      content: Buffer.from(README(raffle), "utf8").toString("base64"),
      branch: config.github.branch,
      ...(sha ? { sha } : {}),
    },
  });
}

/**
 * Publica raffle.json + numbers.json (y draw.json si hay ganador) al repo de la rifa.
 * Crea el repo la primera vez. Nunca lanza hacia el llamador: publicar es un efecto
 * secundario y no debe tumbar una venta ya cobrada (el backend sigue sirviendo el
 * JSON por su API). El error se registra y se devuelve.
 */
export async function publishPublicState(store, slug, { draw = null } = {}) {
  const raffle = await store.publicRaffle(slug);
  const numbers = await store.publicNumbers(slug);

  if (!isGithubConfigured()) {
    return { published: false, reason: "GitHub no configurado (modo demo)", raffle, numbers, draw };
  }

  try {
    const nuevo = await ensureRepo(slug, raffle);
    if (nuevo) await putReadme(slug, raffle);

    await putFile(slug, "public/raffle.json", raffle,
      `chore: raffle.json (${raffle.status})`);
    const commit = await putFile(slug, "public/numbers.json", numbers,
      `chore: ${numbers.sold.length} numero(s) vendido(s)`);
    if (draw) {
      await putFile(slug, "public/draw.json", draw,
        `feat: ganador declarado — numero ${draw.winningNumber}`);
    }

    const repo = `${config.github.owner}/${slug}`;
    // Deja constancia de que ESTA rifa ya vive en GitHub. Es lo unico que le
    // permite al admin distinguir "sin publicar" de "publicada" tras recargar.
    // Si falla, no se toca el resultado: la publicacion SI ocurrio.
    try {
      await store.markPublished(slug, repo);
    } catch (e) {
      console.error("[publish] no se pudo marcar como publicada:", e.message);
    }

    return {
      published: true,
      created: nuevo,
      repo,
      url: `https://github.com/${repo}`,
      rawBase: `https://raw.githubusercontent.com/${repo}/${config.github.branch}/public`,
      commit,
    };
  } catch (e) {
    console.error("[publish]", e.message);
    return { published: false, reason: e.message };
  }
}
