CREATE TABLE jackpot_draws (
 id UUID PRIMARY KEY, season_id UUID NOT NULL UNIQUE REFERENCES seasons(id),
 season_number INTEGER NOT NULL UNIQUE CHECK (season_number > 0),
 pot BIGINT NOT NULL CHECK(pot >= 0), participants JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE jackpot_prizes (
 id UUID PRIMARY KEY, draw_id UUID NOT NULL REFERENCES jackpot_draws(id),
 user_id UUID NOT NULL REFERENCES users(id), username TEXT NOT NULL,
 place INTEGER NOT NULL CHECK(place BETWEEN 1 AND 3), amount BIGINT NOT NULL CHECK(amount >= 0),
 claimed_at TIMESTAMPTZ,
 UNIQUE(draw_id,place), UNIQUE(draw_id,user_id)
);
CREATE INDEX jackpot_prizes_user_id_claimed_at_idx ON jackpot_prizes(user_id,claimed_at);
