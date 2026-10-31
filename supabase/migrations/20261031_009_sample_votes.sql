-- One like (1) or dislike (-1) per user per sample
CREATE TABLE IF NOT EXISTS sample_votes (
    sample_id UUID NOT NULL REFERENCES user_samples(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vote SMALLINT NOT NULL CHECK (vote IN (1, -1)),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (sample_id, user_id)
);

ALTER TABLE sample_votes ENABLE ROW LEVEL SECURITY;
