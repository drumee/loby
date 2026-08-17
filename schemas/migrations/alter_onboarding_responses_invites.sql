-- File: loby/schemas/migrations/alter_onboarding_responses_invites.sql
--
-- Adds the invite step's answer to the onboarding record. Every other step in
-- the wizard writes what the user said into onboarding_responses; the invite
-- step wrote nothing at all — the addresses went out through contact/invite and
-- left no trace on the row, so a response could not tell "invited nobody" from
-- "invited four people", and the funnel export had a blank where the last step
-- should be.
--
-- Holds the addresses that were actually accepted by contact/invite, not the
-- ones staged in the UI.
--
-- Safe to run multiple times.

ALTER TABLE `onboarding_responses`
  ADD COLUMN IF NOT EXISTS `invites` JSON NULL
    COMMENT 'Array of email addresses successfully invited at the invite step'
    AFTER `challenge_note`;
