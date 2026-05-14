-- src/db/migrations/0005_jsonb_rewrite.sql
--
-- JSON-everywhere prompt architecture migration.
--
-- The wire/storage shapes for courses.clarification, courses.framework,
-- and courses.baseline are rewritten (snake_case → camelCase, field
-- renames text→prompt, single_select→multiple_choice, answers→responses).
-- The app is pre-launch and these tables carry no production data, so
-- we truncate in-flight scoping state rather than write a back-compat
-- shim.
--
-- After this migration applies, the next clarify call on any course
-- starts a fresh scoping pass.

BEGIN;

-- Drop in-flight scoping conversations (cascades to context_messages).
TRUNCATE TABLE scoping_passes CASCADE;

-- Defensive: if any context_messages rows survived the cascade
-- (e.g. a wave was opened then abandoned), clear them too.
TRUNCATE TABLE context_messages CASCADE;

-- Reset the scoping JSONB columns on every course.
UPDATE courses
SET clarification = NULL,
    framework = NULL,
    baseline = NULL;

COMMIT;
