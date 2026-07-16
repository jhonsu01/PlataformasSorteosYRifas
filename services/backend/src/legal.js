// Responsable de la rifa (transparencia legal).
//
// Compartido por los dos stores. Todo publico: se muestra en la web y en la app
// del cliente para que quede claro QUIEN convoca cada sorteo y bajo que regimen.
// El autor del software no es responsable de los sorteos de terceros.

import { httpError } from "./http-error.js";

export const REGIMENES = ["DESCENTRALIZADA", "REGULADA"];

export const LIMITES_LEGAL = {
  name: 120,
  authorization: 400,
  documentos: 6,
};

const txt = (v, max, campo) => {
  const s = String(v ?? "").trim();
  if (s.length > max) throw httpError(400, `${campo}: maximo ${max} caracteres`);
  return s;
};

/**
 * URL https de un documento de legalidad (permiso, resolucion...).
 *
 * Solo https: estas URLs se renderizan como enlaces en la web y el admin. Un
 * `javascript:` o `data:` seria un vector de XSS por un campo de formulario.
 */
function docUrl(v, i) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  let u;
  try {
    u = new URL(s);
  } catch {
    throw httpError(400, `organizer.documents[${i}]: URL invalida`);
  }
  if (u.protocol !== "https:") throw httpError(400, `organizer.documents[${i}]: solo URLs https`);
  return u.toString();
}

/**
 * Normaliza el bloque del responsable.
 *
 * `name` es quien convoca (el minimo). `regime` distingue una rifa REGULADA (con
 * permiso oficial) de una DESCENTRALIZADA (comunitaria/informal). `authorization`
 * y `documents` son opcionales: quien tenga permiso puede citarlo; quien no, al
 * menos se identifica y declara el regimen.
 */
export function normalizeOrganizer(v) {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw httpError(400, "organizer: debe ser un objeto");

  const out = {};
  const name = txt(v.name, LIMITES_LEGAL.name, "organizer.name");
  if (name) out.name = name;

  // Si no mandan regimen valido, se asume descentralizada: es lo honesto por
  // defecto para una herramienta libre, y nunca afirma de mas ("regulada" sin
  // serlo seria peor que no decir nada).
  if (v.regime != null && v.regime !== "") {
    const r = String(v.regime).trim().toUpperCase();
    if (!REGIMENES.includes(r)) {
      throw httpError(400, `organizer.regime: debe ser ${REGIMENES.join(" o ")}`);
    }
    out.regime = r;
  } else if (name) {
    out.regime = "DESCENTRALIZADA";
  }

  const auth = txt(v.authorization, LIMITES_LEGAL.authorization, "organizer.authorization");
  if (auth) out.authorization = auth;

  if (v.documents != null) {
    if (!Array.isArray(v.documents)) throw httpError(400, "organizer.documents: debe ser una lista");
    if (v.documents.length > LIMITES_LEGAL.documentos) {
      throw httpError(400, `organizer.documents: maximo ${LIMITES_LEGAL.documentos} enlaces`);
    }
    const docs = v.documents.map((d, i) => docUrl(d, i)).filter(Boolean);
    if (docs.length) out.documents = docs;
  }

  return out;
}
