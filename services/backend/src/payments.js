// Medios de pago manuales y comprobantes.
//
// Compartido por los dos stores (memoria y PostgreSQL): escrito dos veces
// divergiria, y los tests corren en memoria.

import { httpError } from "./http-error.js";

export const LIMITES_PAGO = {
  medios: 8,
  label: 40,      // "Bancolombia ahorros"
  value: 80,      // numero de cuenta / llave / telefono
  hint: 120,      // "A nombre de Jhon S."
  // 1,2 MB de comprobante ya reducido. El techo real es Vercel: corta el cuerpo
  // en ~4,5 MB y el base64 infla un 33%. El cliente reduce antes de subir.
  comprobanteBytes: 1_200_000,
};

const txt = (v, max, campo) => {
  const s = String(v ?? "").trim();
  if (s.length > max) throw httpError(400, `${campo}: maximo ${max} caracteres`);
  return s;
};

/**
 * Medios de pago de una rifa: como se le paga a un humano.
 *
 * `label` es el nombre del medio ("Nequi", "Bre-B"), `value` el dato que el
 * comprador copia (telefono, llave, numero de cuenta) y `hint` una aclaracion
 * opcional ("A nombre de..."). Se guarda como texto libre a proposito: el
 * catalogo de medios de pago colombianos cambia mas rapido que este codigo.
 */
export function normalizePaymentMethods(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw httpError(400, "paymentMethods: debe ser una lista");
  if (v.length > LIMITES_PAGO.medios) {
    throw httpError(400, `paymentMethods: maximo ${LIMITES_PAGO.medios} medios`);
  }
  return v.map((raw, i) => {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      throw httpError(400, `paymentMethods[${i}]: debe ser un objeto`);
    }
    const label = txt(raw.label, LIMITES_PAGO.label, `paymentMethods[${i}].label`);
    const value = txt(raw.value, LIMITES_PAGO.value, `paymentMethods[${i}].value`);
    // Un medio sin nombre o sin dato no sirve para pagar: es ruido en pantalla.
    if (!label) throw httpError(400, `paymentMethods[${i}].label: requerido (ej: Nequi)`);
    if (!value) throw httpError(400, `paymentMethods[${i}].value: requerido (ej: 3200000000)`);
    const out = { label, value };
    const hint = txt(raw.hint, LIMITES_PAGO.hint, `paymentMethods[${i}].hint`);
    if (hint) out.hint = hint;
    return out;
  });
}

// Firmas reales de imagen. No se confia en el mime que manda el cliente: el
// comprobante lo va a abrir un administrador, y lo que llega es un archivo de
// un desconocido.
const FIRMAS = [
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/webp", test: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
];

/** Valida el comprobante y devuelve su mime REAL (el de los bytes, no el declarado). */
export function validarComprobante(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw httpError(400, "Comprobante vacio");
  if (bytes.length > LIMITES_PAGO.comprobanteBytes) {
    throw httpError(413, `Comprobante demasiado grande (maximo ${(LIMITES_PAGO.comprobanteBytes / 1e6).toFixed(1)} MB)`);
  }
  const firma = FIRMAS.find((f) => f.test(bytes));
  if (!firma) throw httpError(400, "El comprobante debe ser una imagen (JPG, PNG o WEBP)");
  return firma.mime;
}

/**
 * Comprueba que la rifa acepta ese metodo de pago.
 *
 * Se valida en el SERVIDOR y no solo escondiendo el boton en la app: apagar la
 * pasarela tiene que significar que no entra ni una compra por ahi, aunque
 * alguien llame a la API a mano.
 */
export function assertMetodoPermitido(raffle, method) {
  if (method === "WOMPI" && raffle.gatewayEnabled === false) {
    throw httpError(409, "Esta rifa no acepta pagos con pasarela (Wompi) en este momento");
  }
  if (method === "MANUAL" && raffle.manualEnabled === false) {
    throw httpError(409, "Esta rifa no acepta pagos manuales en este momento");
  }
}

/**
 * Valida el par de fechas.
 *
 * El sorteo no puede jugarse antes de cerrar las ventas: seria vender numeros
 * para un sorteo ya jugado.
 */
export function assertFechas(endsAt, drawAt) {
  if (!endsAt || !drawAt) return;
  if (new Date(drawAt) < new Date(endsAt)) {
    throw httpError(400, "La fecha del sorteo no puede ser antes del cierre de ventas");
  }
}
