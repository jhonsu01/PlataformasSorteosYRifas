-- 004: el premio deja de ser una linea de texto y pasa a ser algo mostrable.
--
-- Motivacion: `prize` era un TEXT ("Un computador"). Una rifa real se vende con
-- fotos, video y el desglose de lo que se gana con su valor. Ademas el admin no
-- tenia forma de saber si una rifa ya estaba publicada en GitHub: el boton
-- "Publicar" se veia igual siempre y el enlace al repo se perdia al recargar.
--
-- Idempotente (IF NOT EXISTS): migrate.js re-ejecuta el archivo sin dano.

ALTER TABLE raffles
  -- Estado de publicacion. NULL = nunca publicada. Lo escribe el publicador.
  ADD COLUMN IF NOT EXISTS published_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS repo_full_name TEXT,

  -- { "cover": "https://raw...", "gallery": ["https://raw...", ...],
  --   "youtubeId": "dQw4w9WgXcQ" }
  -- Solo URLs y un id de video: nada binario vive en la base. Las imagenes se
  -- commitean al repo publico de la rifa (misma regla que numbers.json: la rifa
  -- se verifica aunque el backend se apague).
  ADD COLUMN IF NOT EXISTS media          JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- [ { "name": "Microscopio", "description": "...", "valueCents": 130000000,
  --     "imageUrl": "https://raw...", "featured": true }, ... ]
  -- El total NO se guarda: se calcula sumando. Un total almacenado se
  -- desincroniza del desglose y el numero que ve el comprador deja de cuadrar
  -- con la lista que tiene debajo.
  ADD COLUMN IF NOT EXISTS prize_items    JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- { "accent": "#f5c518" }. Cada rifa lleva su marca; la web usa violeta si
  -- no hay nada. Es un framework: el color no puede estar quemado en la web.
  ADD COLUMN IF NOT EXISTS theme          JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Los JSONB deben ser del tipo que dice el comentario, o el JSON publico saldria
-- deforme y la web tendria que defenderse de cada campo.
--
-- Se añaden con DO/EXCEPTION y NO con DROP+ADD: este archivo se re-ejecuta en
-- CADA arranque en frio de la funcion serverless (que son constantes), y un
-- DROP+ADD tomaria un ACCESS EXCLUSIVE y revalidaria la tabla entera cada vez.
-- Asi, tras la primera vez, es un no-op real.
DO $$ BEGIN
  ALTER TABLE raffles ADD CONSTRAINT raffles_prize_items_ck CHECK (jsonb_typeof(prize_items) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE raffles ADD CONSTRAINT raffles_media_ck CHECK (jsonb_typeof(media) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE raffles ADD CONSTRAINT raffles_theme_ck CHECK (jsonb_typeof(theme) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
