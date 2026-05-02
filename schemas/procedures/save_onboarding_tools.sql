-- File: loby/schemas/procedures/save_onboarding_tools.sql
--
-- v2: accepts either a JSON array (new wizard: ["google_drive","notion",...])
-- or a JSON object (legacy v1: { foo: [...], bar: [...] }) so that the old
-- and new clients both work during rollout.

DROP PROCEDURE IF EXISTS `save_onboarding_tools`;

DELIMITER $$

CREATE PROCEDURE `save_onboarding_tools`(
    IN _session_id        VARCHAR(128) CHARACTER SET ascii,
    IN _current_tools_json JSON
)
BEGIN
    IF _session_id IS NULL OR _session_id = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session_id is required';
    END IF;
    IF _current_tools_json IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'current_tools is required';
    END IF;
    IF JSON_VALID(_current_tools_json) = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'current_tools must be valid JSON';
    END IF;
    IF JSON_TYPE(_current_tools_json) NOT IN ('ARRAY','OBJECT') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'current_tools must be a JSON array or object';
    END IF;

    UPDATE onboarding_responses
    SET current_tools = _current_tools_json,
        mtime         = UNIX_TIMESTAMP()
    WHERE session_id = _session_id;

    IF ROW_COUNT() = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Onboarding session not found. Start at step 1.';
    END IF;
END$$

DELIMITER ;
