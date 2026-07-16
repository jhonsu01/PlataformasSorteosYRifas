-- 007: ciudad del comprador (dato PUBLICO).
--
-- El organizador quiere saber desde donde le compran. La ciudad es un dato
-- grueso (no una direccion) y el usuario acepto que sea publico: se muestra en
-- el estado publico junto al seudonimo, como "Juan R. — Medellin". Es lo mismo
-- que hace la referencia del sector (servicellarauca).
--
-- A diferencia de telefono/correo/documento (privados, en `private`), la ciudad
-- va en su propia columna y SI sale a numbers.json.
--
-- Idempotente: migrate.js re-ejecuta el archivo en cada arranque en frio.

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS buyer_city TEXT;
