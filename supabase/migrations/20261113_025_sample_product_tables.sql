-- 025 Create the sample & product listing tables the API expects.
-- These tables were referenced by the API but missing from the database, so samples
-- and product listings silently fell back to a JSON file in Storage. This creates the
-- real tables (idempotent, additive).

-- ---------------------------------------------------------------------------
-- user_samples: work samples (image/video) uploaded by partner / supplier / architect
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_samples (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_type    VARCHAR(10) NOT NULL CHECK (media_type IN ('image', 'video')),
    title         VARCHAR(120),
    media_url     TEXT NOT NULL,
    thumbnail_url TEXT,
    caption       VARCHAR(300),
    price         NUMERIC(12, 2) CHECK (price IS NULL OR price > 0),
    price_unit    VARCHAR(20),
    is_private    BOOLEAN DEFAULT FALSE,
    role          VARCHAR(20),
    phone         VARCHAR(20),
    username      VARCHAR(60),
    business_name VARCHAR(150),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_samples
    ADD COLUMN IF NOT EXISTS title         VARCHAR(120),
    ADD COLUMN IF NOT EXISTS media_url     TEXT,
    ADD COLUMN IF NOT EXISTS thumbnail_url TEXT,
    ADD COLUMN IF NOT EXISTS caption       VARCHAR(300),
    ADD COLUMN IF NOT EXISTS price         NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS price_unit    VARCHAR(20),
    ADD COLUMN IF NOT EXISTS is_private    BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS role          VARCHAR(20),
    ADD COLUMN IF NOT EXISTS phone         VARCHAR(20),
    ADD COLUMN IF NOT EXISTS username      VARCHAR(60),
    ADD COLUMN IF NOT EXISTS business_name VARCHAR(150),
    ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_user_samples_user_day ON user_samples (user_id, created_at);

-- ---------------------------------------------------------------------------
-- sample_votes: one like (1) / dislike (-1) per user per sample
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sample_votes (
    sample_id  UUID NOT NULL REFERENCES user_samples(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vote       SMALLINT NOT NULL CHECK (vote IN (1, -1)),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (sample_id, user_id)
);

-- ---------------------------------------------------------------------------
-- product_listings: supplier / architect / partner product & design listings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_listings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            VARCHAR(20) NOT NULL CHECK (role IN ('partner', 'supplier', 'architect')),
    title           VARCHAR(200) NOT NULL,
    category        VARCHAR(100) NOT NULL,
    sub_category    VARCHAR(100),
    description     TEXT,
    unit            VARCHAR(30) NOT NULL DEFAULT 'sqft',
    rate_per_unit   NUMERIC(10, 2) NOT NULL DEFAULT 0,
    quantity        NUMERIC(10, 2) NOT NULL DEFAULT 1,
    total_amount    NUMERIC(12, 2) NOT NULL DEFAULT 0,
    expected_amount NUMERIC(12, 2),
    with_material   BOOLEAN DEFAULT TRUE,
    image_url       TEXT,
    media_type      VARCHAR(20) DEFAULT 'image',
    is_private      BOOLEAN DEFAULT FALSE,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE product_listings
    ADD COLUMN IF NOT EXISTS sub_category    VARCHAR(100),
    ADD COLUMN IF NOT EXISTS description     TEXT,
    ADD COLUMN IF NOT EXISTS unit            VARCHAR(30) NOT NULL DEFAULT 'sqft',
    ADD COLUMN IF NOT EXISTS rate_per_unit   NUMERIC(10, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS quantity        NUMERIC(10, 2) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS total_amount    NUMERIC(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS expected_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS with_material   BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS image_url       TEXT,
    ADD COLUMN IF NOT EXISTS media_type      VARCHAR(20) DEFAULT 'image',
    ADD COLUMN IF NOT EXISTS is_private      BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_active       BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_product_listings_user ON product_listings (user_id, created_at);

-- ---------------------------------------------------------------------------
-- RLS: backend uses the service role (bypasses RLS); block anon access
-- ---------------------------------------------------------------------------
ALTER TABLE user_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_listings ENABLE ROW LEVEL SECURITY;