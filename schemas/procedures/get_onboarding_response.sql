-- File: loby/schemas/procedures/get_onboarding_response.sql
--
-- v3: uid-aware lookup + the new tools_other / uid columns. Signature gains
-- _uid in position 2. Keeps every v1/v2 alias (`plan`, `tools`, `privacy`) so
-- older clients reading this payload are unaffected.
--
-- This is the read that powers wizard resume, so it deliberately goes through
-- onboarding_resolve_row: when the session has rotated, resolving by uid is
-- what lets the user's existing answers be found at all. _create = 0 — a read
-- never fabricates a row; a user who has not started gets an empty result set,
-- exactly as before.
--
-- Note the resolver may re-point the found row's session_id at the caller's
-- current session. That write is the point: it re-anchors the record to the
-- live session so the subsequent save_* calls in this wizard run land on it.

DROP PROCEDURE IF EXISTS `get_onboarding_response`;

DELIMITER $$

CREATE PROCEDURE `get_onboarding_response`(
    IN _session_id VARCHAR(128) CHARACTER SET ascii,
    IN _uid        VARCHAR(16)  CHARACTER SET ascii
)
BEGIN
    DECLARE _rid INT UNSIGNED;

    CALL onboarding_resolve_row(_session_id, _uid, 0, _rid);

    SELECT
        id,
        session_id,
        uid,
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
        tools_other,
        challenges,
        challenge_note,
        usage_plan,
        usage_plan            AS plan,
        privacy_concern_level,
        privacy_concern_level AS privacy,
        ctime,
        mtime
    FROM onboarding_responses
    WHERE id = _rid;
END$$

DELIMITER ;
