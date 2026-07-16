-- 005: pago manual (sin pasarela), medios de pago por rifa y fecha del sorteo.
--
-- Motivacion: no todo el mundo paga con tarjeta. En Colombia lo normal es Nequi
-- o una transferencia y mandar el pantallazo. Eso exige: publicar los datos de
-- la cuenta, recibir el comprobante y que un humano lo verifique, con el numero
-- retenido mientras tanto.
--
-- Idempotente: migrate.js re-ejecuta el archivo en cada arranque en frio.

-- --------------------------- Rifas ---------------------------

ALTER TABLE raffles
  -- Fecha del SORTEO, distinta de ends_at (cierre de ventas): las ventas cierran
  -- y la loteria externa juega dias despues. Son dos hechos distintos y meterlos
  -- en un solo campo obliga a mentir en uno de los dos.
  ADD COLUMN IF NOT EXISTS draw_at TIMESTAMPTZ,

  -- [ { "label": "Nequi", "value": "3200000000", "hint": "A nombre de Jhon S." } ]
  -- NO se publican a GitHub: el repo publico existe para VERIFICAR el sorteo y su
  -- historial es inmutable; un numero de cuenta commiteado ahi queda para siempre
  -- aunque luego se cambie. Para COMPRAR no hace falta que sobrevivan sin backend
  -- (si el backend esta caido no hay compra posible). Se sirven por la API.
  ADD COLUMN IF NOT EXISTS payment_methods JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Que medios acepta ESTA rifa. Ambos por defecto para no cambiar el
  -- comportamiento de las rifas que ya existen.
  ADD COLUMN IF NOT EXISTS gateway_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS manual_enabled  BOOLEAN NOT NULL DEFAULT true;

DO $$ BEGIN
  ALTER TABLE raffles ADD CONSTRAINT raffles_payment_methods_ck
    CHECK (jsonb_typeof(payment_methods) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- El sorteo no puede jugarse ANTES de cerrar las ventas. NOT VALID: las rifas
-- que ya existen tienen draw_at NULL y no se revalidan (NULL pasa el CHECK, pero
-- NOT VALID ademas evita escanear la tabla al añadir la restriccion).
DO $$ BEGIN
  ALTER TABLE raffles ADD CONSTRAINT raffles_draw_after_ends_ck
    CHECK (draw_at IS NULL OR ends_at IS NULL OR draw_at >= ends_at) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- --------------------------- Comprobantes ---------------------------

ALTER TABLE purchases
  -- El comprobante es PRIVADO: lleva nombre, banco y a veces saldo. Jamas sale al
  -- estado publico. Por eso vive aqui y no en el repo de la rifa (donde SI viven
  -- las fotos del premio, que son publicas por naturaleza).
  ADD COLUMN IF NOT EXISTS receipt_image BYTEA,
  ADD COLUMN IF NOT EXISTS receipt_mime  TEXT,
  ADD COLUMN IF NOT EXISTS receipt_at    TIMESTAMPTZ;

-- Encontrar rapido las compras que esperan revision humana.
CREATE INDEX IF NOT EXISTS purchases_pendientes_con_comprobante_idx
  ON purchases (slug, receipt_at)
  WHERE status = 'PENDING' AND receipt_at IS NOT NULL;
