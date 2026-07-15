// Entrada serverless (Vercel). Ruta catch-all: toda peticion a /api/* llega aqui
// y app.js hace el enrutado interno leyendo req.url.
// El store se cachea a nivel de modulo, asi que se reutiliza entre invocaciones
// del mismo contenedor (no abre un pool por request).

import { handler } from "../src/app.js";

export default handler;
