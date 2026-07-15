// Configuracion desde variables de entorno. Los secretos NUNCA se hardcodean
// (ver .env.example). Todo tiene un default seguro para modo demo/test.

export const config = {
  port: Number(process.env.PORT || 8787),

  // Si esta definida, el backend persiste en PostgreSQL; si no, usa memoria
  // (util para demo/desarrollo, pero se pierde al reiniciar).
  databaseUrl: process.env.DATABASE_URL || "",

  // Minutos que un numero queda RESERVED antes de liberarse si no hay pago.
  reserveMinutes: Number(process.env.RESERVE_MINUTES || 15),

  wompi: {
    env: process.env.WOMPI_ENV || "test", // test | prod
    publicKey: process.env.WOMPI_PUBLIC_KEY || "",
    // Llave privada de integridad (firma del checkout, lado servidor).
    integrityKey: process.env.WOMPI_PRIVATE_KEY || "",
    // Llave de eventos: verificacion del checksum del webhook.
    eventsKey: process.env.WOMPI_EVENTS_KEY || "",
  },

  github: {
    // PAT fine-grained o token de GitHub App con contenido:write SOLO en repos de rifas.
    token: process.env.GITHUB_TOKEN || "",
    org: process.env.GITHUB_RIFFLES_ORG || "",
    branch: process.env.GITHUB_RIFFLES_BRANCH || "main",
  },
};

export function isGithubConfigured() {
  return Boolean(config.github.token && config.github.org);
}
