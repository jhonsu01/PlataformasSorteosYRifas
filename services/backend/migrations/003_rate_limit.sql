-- Rate limiting con ventana fija (Guia 5.3). Idempotente.
--
-- En serverless no sirve un contador en memoria: cada contenedor tendria el suyo
-- y el limite seria facil de esquivar. El contador vive en la base y se
-- incrementa de forma atomica (INSERT ... ON CONFLICT DO UPDATE).

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT PRIMARY KEY,          -- "<nombre>:<extra>:<ip>:<inicio_ventana>"
  hits       INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Para que el cron pueda barrer las ventanas vencidas.
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits (expires_at);
