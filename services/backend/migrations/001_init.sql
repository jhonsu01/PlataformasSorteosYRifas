-- Esquema inicial del backend de Sorteos y Rifas (PostgreSQL).
-- Privacidad por diseno: los datos sensibles del comprador viven en
-- purchases.private (JSONB) y NUNCA se derivan al estado publico.
-- Idempotente: se puede ejecutar varias veces.

CREATE TABLE IF NOT EXISTS raffles (
  slug             TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  prize            TEXT NOT NULL,
  price_cents      BIGINT NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'COP',
  number_min       INTEGER NOT NULL,
  number_max       INTEGER NOT NULL,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  min_sold_to_draw INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'ACTIVE',
  winner           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT raffles_range_ck CHECK (number_max >= number_min)
);

CREATE TABLE IF NOT EXISTS purchases (
  id                   UUID PRIMARY KEY,
  slug                 TEXT NOT NULL REFERENCES raffles(slug) ON DELETE CASCADE,
  number               INTEGER NOT NULL,
  method               TEXT NOT NULL,                 -- WOMPI | MANUAL
  status               TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|APPROVED|REJECTED|REFUNDED
  reference            TEXT NOT NULL UNIQUE,
  amount_cents         BIGINT NOT NULL,
  buyer_public         TEXT NOT NULL,                 -- "Juan S." (seudonimo)
  private              JSONB NOT NULL DEFAULT '{}'::jsonb, -- telefono/correo/documento
  receipt_url          TEXT,                          -- comprobante (acceso privado)
  wompi_transaction_id TEXT,
  purchased_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at          TIMESTAMPTZ,
  approved_by          TEXT,
  note                 TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchases_slug_status ON purchases (slug, status);

CREATE TABLE IF NOT EXISTS tickets (
  slug           TEXT NOT NULL REFERENCES raffles(slug) ON DELETE CASCADE,
  number         INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'FREE',        -- FREE|RESERVED|SOLD|VOID
  reserved_until TIMESTAMPTZ,
  purchase_id    UUID REFERENCES purchases(id) ON DELETE SET NULL,
  PRIMARY KEY (slug, number)
);
CREATE INDEX IF NOT EXISTS idx_tickets_slug_status ON tickets (slug, status);

-- Idempotencia del webhook de Wompi (por id de transaccion).
CREATE TABLE IF NOT EXISTS processed_events (
  transaction_id TEXT PRIMARY KEY,
  processed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS draws (
  id             SERIAL PRIMARY KEY,
  slug           TEXT NOT NULL REFERENCES raffles(slug) ON DELETE CASCADE,
  drawn_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  winning_number INTEGER NOT NULL,
  mechanism      TEXT NOT NULL,                       -- ADMIN_INPUT|RANDOM_FROM_SOLD
  winner         JSONB,
  status         TEXT NOT NULL DEFAULT 'VALID'        -- VALID|VOID|POSTPONED
);

-- Auditoria de acciones relevantes (Guia 5.3).
CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  actor       TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  before      JSONB,
  after       JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
