// Entrada serverless (Vercel). UNA sola funcion: vercel.json reescribe TODAS las
// rutas hacia aqui y app.js enruta internamente leyendo la ruta original.
//
// Por que NO se usa `api/[...path].js`: la sintaxis catch-all `[...param]` es una
// convencion de Next.js. En un proyecto Node plano, Vercel la registra como un
// UNICO segmento dinamico: /api/raffles funcionaba, pero /api/webhooks/wompi
// (2 segmentos) devolvia 404 y el webhook de Wompi jamas habria llegado.
// El rewrite a una funcion unica es el patron estandar (el mismo de Express en Vercel).
//
// El store se cachea a nivel de modulo, asi que se reutiliza entre invocaciones
// del mismo contenedor (no abre un pool por request).

import { handler } from "../src/app.js";

export default handler;
