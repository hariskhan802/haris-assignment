-- ===========================================================================
-- 001_init.sql — schema for the AI-powered financial chat application.
-- Idempotent: safe to run repeatedly (the migrate script also tracks applied
-- migrations in schema_migrations).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Financial products. The stored annual_interest_rate is the trusted source of
-- truth for questions like "…using the stored interest rate".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS financial_products (
    id                    SERIAL PRIMARY KEY,
    name                  TEXT           NOT NULL UNIQUE,
    product_type          TEXT           NOT NULL
                          CHECK (product_type IN ('loan', 'savings', 'investment')),
    -- Stored as a percentage (6.500 = 6.5% per year), not a decimal fraction.
    annual_interest_rate  NUMERIC(6, 3)  NOT NULL
                          CHECK (annual_interest_rate >= 0 AND annual_interest_rate <= 100),
    min_term_years        INTEGER        CHECK (min_term_years  > 0),
    max_term_years        INTEGER        CHECK (max_term_years  > 0),
    description           TEXT,
    created_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    CONSTRAINT term_range_valid CHECK (
        min_term_years IS NULL OR max_term_years IS NULL OR min_term_years <= max_term_years
    )
);

-- Case-insensitive product lookup ("home loan" == "Home Loan").
CREATE INDEX IF NOT EXISTS idx_financial_products_name_lower
    ON financial_products (LOWER(name));
CREATE INDEX IF NOT EXISTS idx_financial_products_type
    ON financial_products (product_type);

-- ---------------------------------------------------------------------------
-- One chat thread.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    title       TEXT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Every user message and assistant reply. Assistant rows additionally carry the
-- audit trail of the calculation that backed the answer:
--   calculation_type    e.g. 'loan_payment'
--   calculation_result  the single headline number (monthly payment / future value)
--   calculation_details full inputs + outputs + which product was used (JSONB)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id                   BIGSERIAL    PRIMARY KEY,
    conversation_id      UUID         NOT NULL
                         REFERENCES conversations (id) ON DELETE CASCADE,
    role                 TEXT         NOT NULL CHECK (role IN ('user', 'assistant')),
    content              TEXT         NOT NULL,
    calculation_type     TEXT         CHECK (
                             calculation_type IN ('compound_interest', 'loan_payment')
                         ),
    calculation_result   NUMERIC(18, 2),
    calculation_details  JSONB,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- A user message can never carry calculation output.
    CONSTRAINT calc_only_on_assistant CHECK (
        role = 'assistant' OR (calculation_type IS NULL AND calculation_result IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
    ON messages (conversation_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_messages_calculation_type
    ON messages (calculation_type) WHERE calculation_type IS NOT NULL;
