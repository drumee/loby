-- File: loby/schemas/procedures/save_onboarding_challenges.sql

DROP PROCEDURE IF EXISTS `save_onboarding_challenges`;

DELIMITER $$

CREATE PROCEDURE `save_onboarding_challenges`(
    IN _session_id      VARCHAR(128) CHARACTER SET ascii,
    IN _challenges_json JSON,
    IN _note            VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
)
BEGIN
    IF _session_id IS NULL OR _session_id = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session_id is required';
    END IF;

    IF _challenges_json IS NOT NULL AND JSON_VALID(_challenges_json) = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'challenges must be valid JSON';
    END IF;

    IF _challenges_json IS NOT NULL
       AND JSON_TYPE(_challenges_json) NOT IN ('ARRAY','OBJECT') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'challenges must be an array or object';
    END IF;

    UPDATE onboarding_responses
    SET challenges     = _challenges_json,
        challenge_note = NULLIF(_note, ''),
        mtime          = UNIX_TIMESTAMP()
    WHERE session_id = _session_id;

    IF ROW_COUNT() = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Onboarding session not found. Start at step 1.';
    END IF;
END$$

DELIMITER ;
