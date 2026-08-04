-- File: loby/schemas/migrations/alter_onboarding_responses_identity.sql
--
-- Additive, idempotent. Safe to run repeatedly and on any v2 instance.
--
-- WHY
-- ---
-- `session_id` was the only write key on onboarding_responses. A session is a
-- transient artefact (it rotates on re-login, token refresh and expiry), so
-- keying durable survey answers on it means the answers are lost the moment
-- the session changes: every UPDATE-only step procedure matched zero rows and
-- raised "Onboarding session not found. Start at step 1."
--
-- `uid` gives the row a STABLE owner. session_id is kept as-is (still UNIQUE,
-- still the lookup key for legacy/anonymous rows) so nothing that reads this
-- table today has to change; uid is simply a second, durable way in. See
-- procedures/onboarding_resolve_row.sql for the resolution order.
--
-- `tools_other` completes the "Other -> type your own" model. industry and
-- role already store their custom text in dedicated *_other columns; tools
-- was the odd one out, splicing the raw user string into the current_tools
-- JSON array where it was indistinguishable from a canonical key. See
-- migrations/backfill_tools_other.sql for the legacy data fix-up.

ALTER TABLE `onboarding_responses`
  ADD COLUMN IF NOT EXISTS `uid` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_general_ci NULL
      COMMENT 'Stable owner (yp.drumate.id). Survives session rotation.'
      AFTER `session_id`,
  ADD COLUMN IF NOT EXISTS `tools_other` VARCHAR(255) NULL
      COMMENT 'Free-text value when current_tools contains "other"'
      AFTER `current_tools`;

-- Non-unique on purpose: a user may legitimately hold more than one row
-- (legacy anonymous row + current one). onboarding_resolve_row picks the most
-- recently touched, so this must not be a UNIQUE constraint.
ALTER TABLE `onboarding_responses`
  ADD INDEX IF NOT EXISTS `idx_uid` (`uid`);
