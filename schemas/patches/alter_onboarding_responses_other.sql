-- File: loby/schemas/patches/alter_onboarding_responses_other.sql
-- Adds free-text custom values captured when the user picks "Other" on the
-- industry / role onboarding steps. Idempotent-ish: guard with IF NOT EXISTS
-- where the server's MariaDB supports it; otherwise run once per instance.

ALTER TABLE onboarding_responses
  ADD COLUMN industry_other VARCHAR(255) NULL AFTER industry,
  ADD COLUMN role_other     VARCHAR(255) NULL AFTER role;
