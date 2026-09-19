ALTER TABLE "crash_rounds" DROP CONSTRAINT IF EXISTS "crash_rounds_crash_at_check";
ALTER TABLE "crash_rounds" ADD CONSTRAINT "crash_rounds_crash_at_check" CHECK ("crash_at_hundredths" >= 100);
