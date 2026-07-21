-- 009: ordenes de varios numeros con UN solo pago.
--
-- Motivacion: el comprador queria apartar hasta 10 numeros de una vez y pagar
-- UNA sola vez (no numero por numero). Modelo: cada numero sigue siendo su propia
-- fila en purchases (para el estado publico, el ganador, etc.), pero las filas de
-- una misma compra comparten `order_ref`. El pago (Wompi o el comprobante manual)
-- se hace a nivel de ORDEN: una firma/monto por el total y una decision (aprobar/
-- rechazar) que cae sobre todo el grupo.
--
-- Compatibilidad: una compra de UN numero es simplemente una orden de tamaño 1.
-- Las compras viejas se rellenan con order_ref = reference (cada una su propia
-- orden), asi el webhook por orden las sigue encontrando igual.
--
-- Idempotente: migrate.js re-ejecuta el archivo en cada arranque en frio.

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS order_ref TEXT;

-- Rellenar las compras existentes: cada una es su propia orden.
UPDATE purchases SET order_ref = reference WHERE order_ref IS NULL;

-- Buscar rapido todas las filas de una orden (webhook, aprobar/rechazar en grupo).
CREATE INDEX IF NOT EXISTS idx_purchases_order_ref ON purchases (order_ref);
