-- File: loby/schemas/procedures/mark_onboarding_complete.sql
--
-- v2: validates the new required-step set (firstname, industry, role,
-- team_size, tools). intent + challenges are optional. Returns the full
-- record so the caller can sync to the drumate profile.

DROP PROCEDURE IF EXISTS `mark_onboarding_complete`;

DELIMITER $$

CREATE PROCEDURE `mark_onboarding_complete`(
    IN _session_id VARCHAR(128) CHARACTER SET ascii
)
BEGIN
    DECLARE v_firstname   VARCHAR(128);
    DECLARE v_industry    VARCHAR(32);
    DECLARE v_role        VARCHAR(32);
    DECLARE v_team_size   VARCHAR(16);
    DECLARE v_tools       JSON;
    DECLARE v_tools_count INT DEFAULT 0;

    IF _session_id IS NULL OR _session_id = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session_id is required';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM onboarding_responses WHERE session_id = _session_id) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'User onboarding not found. Please start from step 1.';
    END IF;

    SELECT firstname, industry, role, team_size, current_tools,
           CASE
             WHEN current_tools IS NULL THEN 0
             WHEN JSON_TYPE(current_tools) = 'ARRAY'  THEN JSON_LENGTH(current_tools)
             WHEN JSON_TYPE(current_tools) = 'OBJECT' THEN JSON_LENGTH(JSON_KEYS(current_tools))
             ELSE 0
           END
    INTO   v_firstname, v_industry, v_role, v_team_size, v_tools, v_tools_count
    FROM onboarding_responses
    WHERE session_id = _session_id;

    IF v_firstname IS NULL OR v_firstname = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Step 1 (name) is incomplete.';
    END IF;
    IF v_industry IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Step 2 (industry) is incomplete.';
    END IF;
    IF v_role IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Step 3 (role) is incomplete.';
    END IF;
    IF v_team_size IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Step 4 (team size) is incomplete.';
    END IF;
    IF v_tools IS NULL OR v_tools_count = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Step 6 (tools) is incomplete.';
    END IF;

    SELECT
        session_id,
        TRUE          AS is_completed,
        'completed'   AS status,
        firstname,
        lastname,
        email,
        country_code,
        industry,
        role,
        team_size,
        intent,
        current_tools,
        challenges,
        challenge_note,
        ctime,
        mtime
    FROM onboarding_responses
    WHERE session_id = _session_id;
END$$

DELIMITER ;
