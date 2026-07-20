-- File: loby/schemas/patches/alter_onboarding_responses_other.sql
-- Adds free-text custom values captured when the user picks "Other" on the
-- industry / role onboarding steps. Safe to run multiple times.

ALTER TABLE `onboarding_responses`
  ADD COLUMN IF NOT EXISTS `industry_other` VARCHAR(255) NULL AFTER `industry`,
  ADD COLUMN IF NOT EXISTS `role_other`     VARCHAR(255) NULL AFTER `role`;
