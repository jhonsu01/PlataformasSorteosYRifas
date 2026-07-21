-- 008: usuarios VENDEDORES (promotores) y quien autorizo cada pago manual.
--
-- Motivacion: el dueño no siempre esta para verificar los pantallazos. Necesita
-- delegar en promotores que SOLO pueden: ver las rifas que les asignaron y
-- aprobar pagos manuales de esas rifas. No son administradores: no crean rifas,
-- no anulan ventas, no ven las demas.
--
-- Decision de modelo: un vendedor NO es una tabla nueva, es un admin_users con
-- role='OPERATOR'. Asi reutiliza login, refresh rotativo, 2FA y hashing tal cual.
-- Lo unico nuevo es (a) un nombre para mostrar y (b) que rifas puede tocar.
--
-- Idempotente: migrate.js re-ejecuta el archivo en cada arranque en frio.

-- --------------------------- Vendedores ---------------------------

-- Nombre para mostrar. El correo identifica; el nombre es lo que ve el admin en
-- Comprobantes ("autorizado por: Maria") y lo que se saluda en el correo.
ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS full_name TEXT;

-- Que rifas puede promover/verificar cada vendedor. Revocar acceso = borrar la
-- fila (la cuenta sigue viva). Sin filas -> el vendedor no ve ninguna rifa.
CREATE TABLE IF NOT EXISTS seller_raffles (
  user_id     UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL REFERENCES raffles(slug)   ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by TEXT,                                  -- correo del admin que asigno
  PRIMARY KEY (user_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_seller_raffles_slug ON seller_raffles (slug);

-- --------------------------- Autoria del pago manual ---------------------------

-- Quien aprobo la venta. `approved_by` (correo) ya existia; se añade id + nombre
-- + rol para poder filtrar por vendedor y mostrar el nombre sin un JOIN fragil
-- (el vendedor podria renombrarse; aqui queda congelado el nombre del momento).
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS approved_by_id   UUID,
  ADD COLUMN IF NOT EXISTS approved_by_name TEXT,
  ADD COLUMN IF NOT EXISTS approved_by_role TEXT;   -- ADMIN | SUPER_ADMIN | OPERATOR | wompi | seed

-- Filtrar rapido "las confirmaciones de este vendedor en este rango de fechas".
CREATE INDEX IF NOT EXISTS idx_purchases_approver
  ON purchases (approved_by_id, verified_at)
  WHERE approved_by_id IS NOT NULL;
