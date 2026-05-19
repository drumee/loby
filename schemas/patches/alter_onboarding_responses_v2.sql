-- Migration: onboarding_responses v1 → v2
--
-- The v1 table (from onboarding-server) used first_name/last_name with NOT NULL
-- constraints and an ENUM usage_plan NOT NULL. The v2 wizard (loby) renamed the
-- name columns, relaxed all optional fields to NULL, and added industry/role/
-- team_size/intent/challenges/challenge_note.
--
-- Safe to run multiple times: uses CHANGE COLUMN IF EXISTS / ADD COLUMN IF NOT EXISTS.
-- Note: COMMENT clause is intentionally omitted from MODIFY COLUMN IF EXISTS lines
-- as MariaDB does not support it in that context.

ALTER TABLE `onboarding_responses`
  -- Rename v1 field names (only triggers if old snake_case names exist)
  CHANGE COLUMN IF EXISTS `first_name`  `firstname` VARCHAR(128) NOT NULL,
  CHANGE COLUMN IF EXISTS `last_name`   `lastname`  VARCHAR(128) NULL,

  -- Relax NOT NULL on optional fields — covers tables that already used
  -- firstname/lastname names (CHANGE COLUMN above would have been a no-op)
  MODIFY COLUMN IF EXISTS `firstname`    VARCHAR(128) NOT NULL,
  MODIFY COLUMN IF EXISTS `lastname`     VARCHAR(128) NULL,
  MODIFY COLUMN IF EXISTS `email`        VARCHAR(255) NULL,
  MODIFY COLUMN IF EXISTS `country_code` CHAR(2)      NULL,

  -- v1 usage_plan was ENUM NOT NULL — convert to JSON NULL to match the v2
  -- table definition and preserve any legacy ENUM values already stored
  MODIFY COLUMN IF EXISTS `usage_plan` JSON NULL,

  -- v1 current_tools and privacy_concern_level were NOT NULL
  MODIFY COLUMN IF EXISTS `current_tools`         JSON             NULL DEFAULT NULL,
  MODIFY COLUMN IF EXISTS `privacy_concern_level` TINYINT UNSIGNED NULL,

  -- New v2 columns
  ADD COLUMN IF NOT EXISTS `industry`      VARCHAR(32)   NULL AFTER `country_code`,
  ADD COLUMN IF NOT EXISTS `role`          VARCHAR(32)   NULL AFTER `industry`,
  ADD COLUMN IF NOT EXISTS `team_size`     ENUM('just_me','2_10','10_50','50_plus') NULL AFTER `role`,
  ADD COLUMN IF NOT EXISTS `intent`        VARCHAR(32)   NULL AFTER `team_size`,
  ADD COLUMN IF NOT EXISTS `challenges`    JSON          NULL AFTER `current_tools`,
  ADD COLUMN IF NOT EXISTS `challenge_note` VARCHAR(1024) NULL AFTER `challenges`;
