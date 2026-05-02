-- File: loby/schemas/procedures/save_onboarding_team_size.sql

DROP PROCEDURE IF EXISTS `save_onboarding_team_size`;

DELIMITER $$

CREATE PROCEDURE `save_onboarding_team_size`(
    IN _session_id VARCHAR(128) CHARACTER SET ascii,
    IN _team_size  VARCHAR(16)
)
BEGIN
    IF _session_id IS NULL OR _session_id = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session_id is required';
    END IF;

    IF _team_size NOT IN ('just_me','2_10','10_50','50_plus') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid team_size. Must be just_me|2_10|10_50|50_plus';
    END IF;

    UPDATE onboarding_responses
    SET team_size = _team_size,
        mtime     = UNIX_TIMESTAMP()
    WHERE session_id = _session_id;

    IF ROW_COUNT() = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Onboarding session not found. Start at step 1.';
    END IF;
END$$

DELIMITER ;
