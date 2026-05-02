-- File: loby/schemas/procedures/save_onboarding_intent.sql

DROP PROCEDURE IF EXISTS `save_onboarding_intent`;

DELIMITER $$

CREATE PROCEDURE `save_onboarding_intent`(
    IN _session_id VARCHAR(128) CHARACTER SET ascii,
    IN _intent     VARCHAR(32)
)
BEGIN
    IF _session_id IS NULL OR _session_id = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session_id is required';
    END IF;

    IF _intent NOT IN (
        'manage_projects','work_with_clients','store_sensitive',
        'build_workflows','personal_files'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid intent value';
    END IF;

    UPDATE onboarding_responses
    SET intent = _intent,
        mtime  = UNIX_TIMESTAMP()
    WHERE session_id = _session_id;

    IF ROW_COUNT() = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Onboarding session not found. Start at step 1.';
    END IF;
END$$

DELIMITER ;
