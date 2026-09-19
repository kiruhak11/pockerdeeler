ALTER TABLE "crash_bets"
  ADD COLUMN "auto_cashout_at_hundredths" INTEGER,
  ADD CONSTRAINT "crash_bets_auto_cashout_check"
    CHECK ("auto_cashout_at_hundredths" IS NULL OR "auto_cashout_at_hundredths" >= 101);

ALTER TABLE "crash_rounds"
  DROP CONSTRAINT "crash_rounds_crash_at_check",
  ADD CONSTRAINT "crash_rounds_crash_at_check"
    CHECK ("crash_at_hundredths" >= 100);
