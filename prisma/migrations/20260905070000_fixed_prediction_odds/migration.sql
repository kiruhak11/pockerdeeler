-- Existing tickets retain their original pool settlement contract.
ALTER TABLE prediction_markets
  ADD COLUMN pricing_mode varchar(32) NOT NULL DEFAULT 'pari_mutuel',
  ADD COLUMN quote_liquidity bigint,
  ADD CONSTRAINT prediction_pricing_mode CHECK (pricing_mode IN ('pari_mutuel', 'fixed_odds')),
  ADD CONSTRAINT prediction_quote_liquidity CHECK (quote_liquidity IS NULL OR quote_liquidity > 0);
ALTER TABLE prediction_bets
  ADD COLUMN accepted_odds_hundredths integer,
  ADD COLUMN potential_payout bigint,
  ADD COLUMN placed_street varchar(16),
  ADD CONSTRAINT prediction_fixed_ticket CHECK (
    (accepted_odds_hundredths IS NULL AND potential_payout IS NULL AND placed_street IS NULL)
    OR (accepted_odds_hundredths IS NOT NULL AND accepted_odds_hundredths BETWEEN 101 AND 2500
      AND potential_payout IS NOT NULL AND potential_payout = stake * accepted_odds_hundredths / 100
      AND placed_street IS NOT NULL AND placed_street IN ('preflop', 'flop', 'turn', 'river'))
  );
