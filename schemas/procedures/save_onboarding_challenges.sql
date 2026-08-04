-- File: loby/schemas/procedures/save_onboarding_challenges.sql
--
-- v3:
--   * Row resolution via onboarding_resolve_row (_create = 1). Signature gains
--     _uid in position 2.
--   * A NULL / empty selection now writes an empty JSON array instead of being
--     skipped by the client, so de-selecting every challenge actually clears
--     the stored answer rather than leaving a stale list behind.
--
-- Empty array (answered: none) stays distinct from SQL NULL (never answered),
-- which is the distinction check_onboarding_completion reports on.

DROP PROCEDURE IF EXISTS `save_onboarding_challenges`;

DELIMITER $$

CREATE PROCEDURE `save_onboarding_challenges`(
    IN _session_id      VARCHAR(128) CHARACTER SET ascii,
    IN _uid             VARCHAR(16)  CHARACTER SET ascii,
    IN _challenges_json JSON,
    IN _note            VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
)
BEGIN
    DECLARE _rid INT UNSIGNED;

    IF _challenges_json IS NOT NULL AND JSON_VALID(_challenges_json) = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'challenges must be valid JSON';
    END IF;

    IF _challenges_json IS NOT NULL
       AND JSON_TYPE(_challenges_json) NOT IN ('ARRAY','OBJECT') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'challenges must be an array or object';
    END IF;

    CALL onboarding_resolve_row(_session_id, _uid, 1, _rid);

    UPDATE onboarding_responses
    SET challenges     = COALESCE(_challenges_json, JSON_ARRAY()),
        challenge_note = NULLIF(TRIM(COALESCE(_note, '')), ''),
        mtime          = UNIX_TIMESTAMP()
    WHERE id = _rid;
END$$

DELIMITER ;
