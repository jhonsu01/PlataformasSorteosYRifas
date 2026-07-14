# Backend (API)

Servicio de API (Next.js API Routes o Node serverless) que se conecta en fases
posteriores del proyecto. Responsabilidades (ver [`docs/Guia.md`](../../docs/Guia.md)):

- Reservas atómicas de números y prevención de doble venta.
- Webhook de Wompi (verificación de firma + idempotencia).
- Aprobación de comprobantes manuales.
- Publicación del estado público (`raffle.json`, `numbers.json`, `draw.json`) al repo de la rifa.
- Declaración de ganador y regla de postergación (carry-over).

Los secretos viven en variables de entorno (ver [`.env.example`](../../.env.example)),
nunca en el repositorio ni en las apps cliente.
