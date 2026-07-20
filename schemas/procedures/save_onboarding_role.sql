-- File: loby/schemas/procedures/save_onboarding_role.sql

DROP PROCEDURE IF EXISTS `save_onboarding_role`;

DELIMITER $$

CREATE PROCEDURE `save_onboarding_role`(
    IN _session_id VARCHAR(128) CHARACTER SET ascii,
    IN _role       VARCHAR(32),
    IN _role_other VARCHAR(255)
)
BEGIN
    IF _session_id IS NULL OR _session_id = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session_id is required';
    END IF;

    IF _role NOT IN (
        'founder_ceo','manager_team_lead','executive_associate',
        'freelancer_consultant','other'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid role value';
    END IF;

    UPDATE onboarding_responses
    SET role       = _role,
        role_other = IF(_role = 'other', NULLIF(TRIM(_role_other), ''), NULL),
        mtime      = UNIX_TIMESTAMP()
    WHERE session_id = _session_id;

    IF ROW_COUNT() = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Onboarding session not found. Start at step 1.';
    END IF;
END$$

DELIMITER ;
