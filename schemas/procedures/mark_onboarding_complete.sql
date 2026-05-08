-- File: loby/schemas/procedures/mark_onboarding_complete.sql
--
-- v2: validates required steps only: firstname, industry, role, team_size.
-- intent, tools and challenges are optional ("Tell me later" / "Skip this step"
-- is allowed in the UI for those steps). Returns the full record so the
-- caller (onboarding.update_profile) can sync data to the drumate profile.
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

    IF _session_id IS NULL OR _session_id = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session_id is required';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM onboarding_responses WHERE session_id = _session_id) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'User onboarding not found. Please start from step 1.';
    END IF;

    SELECT firstname, industry, role, team_size
    INTO   v_firstname, v_industry, v_role, v_team_size
    FROM onboarding_responses
    WHERE session_id = _session_id;

    -- Steps 1-4 are mandatory (no "Tell me later" in UI for these steps)
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

    -- Steps 5-7 (intent, tools, challenges, invite) are optional:
    -- the UI provides "Tell me later" / "Skip this step" for all of them.

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