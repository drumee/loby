-- File: loby/schemas/procedures/mark_onboarding_complete.sql
--
-- v3: uid-aware lookup via onboarding_resolve_row (_create = 0). Signature
-- gains _uid in position 2, and the returned row now carries the *_other
-- free-text columns and uid so the caller (onboarding.update_profile) can sync
-- the real answer rather than the literal "other" key.
--
-- _create = 0 is deliberate: completion must never fabricate the row it is
-- validating. A missing row is still a hard error — but it now means "this
-- user genuinely has no onboarding record", not "the session changed", which
-- is the case the resolver absorbs.
--
-- v2: validates required steps only: firstname, industry, role, team_size.
-- intent, tools and challenges are optional ("Tell me later" / "Skip this step"
-- is allowed in the UI for those steps).

DROP PROCEDURE IF EXISTS `mark_onboarding_complete`;

DELIMITER $$

CREATE PROCEDURE `mark_onboarding_complete`(
    IN _session_id VARCHAR(128) CHARACTER SET ascii,
    IN _uid        VARCHAR(16)  CHARACTER SET ascii
)
BEGIN
    DECLARE _rid          INT UNSIGNED;
    DECLARE v_firstname   VARCHAR(128);
    DECLARE v_industry    VARCHAR(32);
    DECLARE v_role        VARCHAR(32);
    DECLARE v_team_size   VARCHAR(16);

    CALL onboarding_resolve_row(_session_id, _uid, 0, _rid);

    IF _rid IS NULL THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'User onboarding not found. Please start from step 1.';
    END IF;

    SELECT firstname, industry, role, team_size
    INTO   v_firstname, v_industry, v_role, v_team_size
    FROM onboarding_responses
    WHERE id = _rid;

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
        uid,
        TRUE          AS is_completed,
        'completed'   AS status,
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
        tools_other,
        challenges,
        challenge_note,
        ctime,
        mtime
    FROM onboarding_responses
    WHERE id = _rid;
END$$

DELIMITER ;
