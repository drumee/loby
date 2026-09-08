-- File: loby/schemas/procedures/onboarding_resolve_row.sql
--
-- Single point of truth for "which onboarding_responses row am I writing to?".
-- Every onboarding procedure now goes through this instead of matching on
-- session_id directly.
--
-- WHY
-- ---
-- Two root causes are fixed here, both of which used to surface as the same
-- symptom ("Onboarding session not found. Start at step 1.") and silently
-- ended a user's onboarding:
--
--   1. Only save_onboarding_user_info could INSERT. Every other step was a
--      bare UPDATE, so if step 1 failed for any reason, steps 2..7 could never
--      succeed — the flow was permanently wedged with no way back.
--      Fix: _create = 1 lets any step materialise the row.
--
--   2. session_id was the only key. Re-login / token refresh / session expiry
--      mid-wizard produced a new sid with no row behind it, so every later
--      step failed even though the user and their answers were unchanged.
--      Fix: fall back to the user's uid and re-point that row at the new
--      session (session adoption).
--
-- RESOLUTION ORDER (deliberate — do not reorder):
--   a. Row for this exact session_id. Authoritative when present, which makes
--      the behaviour byte-identical to the old code for every existing record
--      and every in-flight session. uid is stamped on legacy rows as a
--      side effect, so records migrate themselves on first touch.
--   b. Otherwise the most recently updated row for this uid, whose session_id
--      is re-pointed at the current session. This is the recovery path. It is
--      only reachable when (a) found nothing, so session_id is provably free
--      and the UNIQUE key cannot be violated.
--   c. Otherwise, if _create = 1, a fresh stub row.
--
-- The stub inserts firstname = '' rather than a placeholder: both
-- mark_onboarding_complete and check_onboarding_completion already treat
-- '' as "step 1 incomplete", so a stub can never be mistaken for a finished
-- onboarding. Creating rows from any step does NOT weaken completion
-- validation; it only stops a transient failure from wedging the flow.

DROP PROCEDURE IF EXISTS `onboarding_resolve_row`;

DELIMITER $$

CREATE PROCEDURE `onboarding_resolve_row`(
    IN  _session_id VARCHAR(128) CHARACTER SET ascii,
    IN  _uid        VARCHAR(16)  CHARACTER SET ascii,
    IN  _create     TINYINT,
    OUT _row_id     INT UNSIGNED
)
BEGIN
    DECLARE _sid_row INT UNSIGNED DEFAULT NULL;
    DECLARE _uid_row INT UNSIGNED DEFAULT NULL;

    SET _row_id     = NULL;
    SET _uid        = NULLIF(TRIM(COALESCE(_uid, '')), '');
    SET _session_id = NULLIF(TRIM(COALESCE(_session_id, '')), '');

    IF _session_id IS NULL AND _uid IS NULL THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'session_id or uid is required';
    END IF;

    -- Scalar subqueries, not SELECT ... INTO: they yield NULL on no-match
    -- instead of raising a NOT FOUND warning that a CONTINUE HANDLER would
    -- then have to swallow (and which would mask real errors).
    IF _session_id IS NOT NULL THEN
        SET _sid_row = (
            SELECT id FROM onboarding_responses
            WHERE session_id = _session_id
            LIMIT 1
        );
    END IF;

    IF _sid_row IS NULL AND _uid IS NOT NULL THEN
        SET _uid_row = (
            SELECT id FROM onboarding_responses
            WHERE uid = _uid
            ORDER BY mtime DESC, id DESC
            LIMIT 1
        );
    END IF;

    IF _sid_row IS NOT NULL THEN
        SET _row_id = _sid_row;
        -- Self-migration: adopt uid onto rows written before this column
        -- existed, so the next session change can recover them.
        IF _uid IS NOT NULL THEN
            UPDATE onboarding_responses
            SET uid = _uid
            WHERE id = _row_id AND (uid IS NULL OR uid = '');
        END IF;

    ELSEIF _uid_row IS NOT NULL THEN
        SET _row_id = _uid_row;
        -- Session adoption. Safe: _sid_row IS NULL proves no other row holds
        -- this session_id, so the UNIQUE key is free.
        IF _session_id IS NOT NULL THEN
            UPDATE onboarding_responses
            SET session_id = _session_id
            WHERE id = _row_id;
        END IF;

    ELSEIF _create = 1 THEN
        IF _session_id IS NULL THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'session_id is required to create an onboarding row';
        END IF;
        INSERT INTO onboarding_responses (session_id, uid, firstname, ctime, mtime)
        VALUES (_session_id, _uid, '', UNIX_TIMESTAMP(), UNIX_TIMESTAMP());
        SET _row_id = LAST_INSERT_ID();
    END IF;
END$$

DELIMITER ;
