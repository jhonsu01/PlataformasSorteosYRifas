// Error con codigo HTTP. Modulo propio y sin dependencias a proposito: lo usan
// el store, la autenticacion, el rate limiting y la validacion del premio. Si
// viviera en store.js, cualquier modulo que store.js necesitara importar de
// vuelta crearia un ciclo (paso con raffle-media.js).

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
