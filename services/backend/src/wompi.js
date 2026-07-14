// Integracion Wompi: firma de integridad del checkout + verificacion del
// checksum de los eventos (webhook). Sin dependencias (crypto nativo).
//
// NOTA: el esquema de checksum sigue la documentacion de Wompi (SHA256 de la
// concatenacion de los valores de `signature.properties` + `timestamp` + llave
// de eventos). Debe validarse contra un evento real de Wompi antes de produccion.

import crypto from "node:crypto";

export function getPath(obj, path) {
  return String(path)
    .split(".")
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Firma de integridad para el Widget Checkout (lado servidor):
//   SHA256(`${reference}${amountInCents}${currency}${integrityKey}`)
export function integritySignature(reference, amountInCents, currency, integrityKey) {
  return crypto
    .createHash("sha256")
    .update(`${reference}${amountInCents}${currency}${integrityKey}`)
    .digest("hex");
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Verifica el checksum de un evento de webhook de Wompi.
export function verifyEventSignature(event, eventsSecret) {
  const sig = event?.signature;
  if (!sig || !sig.checksum || !Array.isArray(sig.properties)) return false;
  const concatenated =
    sig.properties.map((p) => String(getPath(event.data, p) ?? "")).join("") +
    String(event.timestamp ?? "") +
    String(eventsSecret ?? "");
  const digest = crypto.createHash("sha256").update(concatenated).digest("hex").toUpperCase();
  return timingSafeEqual(digest, String(sig.checksum).toUpperCase());
}

// Calcula el checksum (util para pruebas y para firmar eventos de ejemplo).
export function computeEventChecksum(event, eventsSecret) {
  const sig = event.signature;
  const concatenated =
    sig.properties.map((p) => String(getPath(event.data, p) ?? "")).join("") +
    String(event.timestamp ?? "") +
    String(eventsSecret ?? "");
  return crypto.createHash("sha256").update(concatenated).digest("hex").toUpperCase();
}

// Traduce el estado de la transaccion Wompi a la accion sobre la compra.
// APPROVED -> vender; DECLINED/ERROR/VOIDED -> liberar; PENDING -> esperar.
export function actionForStatus(status) {
  switch (status) {
    case "APPROVED":
      return "SELL";
    case "DECLINED":
    case "ERROR":
    case "VOIDED":
      return "RELEASE";
    case "PENDING":
    default:
      return "WAIT";
  }
}
