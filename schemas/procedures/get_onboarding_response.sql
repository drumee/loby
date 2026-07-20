-- File: loby/schemas/procedures/get_onboarding_response.sql
--
-- v2: surfaces all new fields plus legacy ones so the wizard can resume
-- from any step. Keeps `plan`, `tools`, `privacy` aliases used by the v1 client.

DROP PROCEDURE IF EXISTS `get_onboarding_response`;

DELIMITER $$

CREATE PROCEDURE `get_onboarding_response`(
    IN _session_id VARCHAR(128) CHARACTER SET ascii
)
BEGIN
    IF _session_id IS NULL OR _session_id = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session_id is required';
    END IF;

    SELECT
        id,
        session_id,
        firstname,
        lastname,
        email,
        country_code,
        industry,
        industry_other,
        role,
        role_other,
        team_size,
        intent,
        current_tools,
        current_tools         AS tools,
        challenges,
        challenge_note,
        usage_plan,
        usage_plan            AS plan,
        privacy_concern_level,
        privacy_concern_level AS privacy,
        ctime,
        mtime
    FROM onboarding_responses
    WHERE session_id = _session_id;
END$$

DELIMITER ;
