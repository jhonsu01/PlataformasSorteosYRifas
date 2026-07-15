-- Autenticacion y autorizacion (Guia 5.1-5.3). Idempotente.

CREATE TABLE IF NOT EXISTS admin_users (
  id            UUID PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,               -- scrypt$N$r$p$salt$hash
  totp_secret   TEXT,                        -- base32; NULL hasta configurar 2FA
  totp_enabled  BOOLEAN NOT NULL DEFAULT false,
  role          TEXT NOT NULL DEFAULT 'ADMIN',  -- SUPER_ADMIN | ADMIN | OPERATOR
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  CONSTRAINT admin_users_role_ck CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'OPERATOR'))
);

-- Refresh tokens rotativos. Se guarda solo el hash (nunca el token en claro).
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens (user_id);
