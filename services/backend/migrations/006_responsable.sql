-- 006: responsable de la rifa (transparencia legal).
--
-- Motivacion: las rifas y sorteos estan regulados en la mayoria de las
-- jurisdicciones. El software es libre y su autor NO es responsable de los
-- sorteos que terceros creen con el. Para que esa responsabilidad quede clara,
-- cada rifa declara QUIEN la convoca y bajo que regimen, y ese dato se muestra
-- publicamente (web + app del cliente).
--
-- A diferencia de payment_methods (que es privado), esto SI es publico y va a
-- raffle.json: es rendicion de cuentas, no un dato de contacto. El organizador
-- se identifica a proposito.
--
-- Idempotente: migrate.js re-ejecuta el archivo en cada arranque en frio.

ALTER TABLE raffles
  -- { "name": "Jhon S.", "regime": "DESCENTRALIZADA",
  --   "authorization": "Permiso ... expedido por ...",   (opcional)
  --   "documents": ["https://.../permiso.pdf"] }          (opcional)
  ADD COLUMN IF NOT EXISTS organizer JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  ALTER TABLE raffles ADD CONSTRAINT raffles_organizer_ck
    CHECK (jsonb_typeof(organizer) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
