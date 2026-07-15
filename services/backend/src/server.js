// Servidor para desarrollo local: envuelve el handler de app.js en un http.Server.
// En serverless (Vercel) NO se usa este archivo; la entrada es api/[...path].js.

import http from "node:http";
import { config } from "./config.js";
import { handler, getStore } from "./app.js";

const server = http.createServer(handler);

// Libera reservas vencidas periodicamente. En serverless esto lo hace el cron
// de Vercel llamando a /api/cron/expire (ver vercel.json).
setInterval(() => {
  getStore().then((s) => s.expireReservations()).catch(() => {});
}, 60_000).unref?.();

// Inicializa el store antes de aceptar trafico (falla rapido si la DB no responde).
await getStore();

server.listen(config.port, () => {
  console.log(`[backend] escuchando en http://localhost:${config.port} (Wompi ${config.wompi.env})`);
  console.log(`[backend] salud: GET /health`);
});

export { server };
