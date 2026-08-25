-- 0001_product.down.sql — clean rollback of 0001_product.sql.
-- Idempotent (IF EXISTS).

BEGIN;

DROP TABLE IF EXISTS golden_questions;
DROP TABLE IF EXISTS principle_index;

COMMIT;