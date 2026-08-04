-- File: loby/schemas/procedures/check_onboarding_completion.sql
--
-- v3: uid-aware lookup via onboarding_resolve_row (_create = 0). Signature
-- gains _uid in position 2. Output shape is unchanged.
--
-- v2: completion = firstname + industry + role + team_size (Steps 1-4).
-- intent, tools and challenges are optional ("Tell me later" / "Skip this step"
-- is allowed in the UI for those steps) — consistent with mark_onboarding_complete.
-- Returns a JSON map of per-step booleans so the client can resume from
-- the first incomplete step.
--
-- step6_tools / step6_challenges report "the user answered", not "the user
-- picked something": an explicitly empty array is a real answer. They are
-- therefore NULL-tested, not length-tested — the previous length test made a
-- deliberate "none of these" indistinguishable from an unanswered step.

DROP PROCEDURE IF EXISTS `check_onboarding_completion`;

DELIMITER $$

CREATE PROCEDURE `check_onboarding_completion`(
    IN _session_id VARCHAR(128) CHARACTER SET ascii,
    IN _uid        VARCHAR(16)  CHARACTER SET ascii
)
BEGIN
    DECLARE _rid          INT UNSIGNED;
    DECLARE v_firstname   VARCHAR(128);
    DECLARE v_industry    VARCHAR(32);
    DECLARE v_role        VARCHAR(32);
    DECLARE v_team_size   VARCHAR(16);
    DECLARE v_intent      VARCHAR(32);
    DECLARE v_tools       JSON;
    DECLARE v_challenges  JSON;
    DECLARE v_completed   BOOLEAN DEFAULT FALSE;

    CALL onboarding_resolve_row(_session_id, _uid, 0, _rid);

    IF _rid IS NULL THEN
        SELECT
            _session_id   AS session_id,
            FALSE         AS is_completed,
            'not_started' AS status,
            NULL          AS steps_completed;
    ELSE
        SELECT
            firstname,
            industry,
            role,
            team_size,
            intent,
            current_tools,
            challenges
        INTO
            v_firstname,
            v_industry,
            v_role,
            v_team_size,
            v_intent,
            v_tools,
            v_challenges
        FROM onboarding_responses
        WHERE id = _rid;

        -- Steps 1-4 are mandatory (no "Tell me later" in UI for these steps).
        -- Steps 5-7 (intent, tools, challenges) are optional — skip allowed.
        SET v_completed = (
            v_firstname IS NOT NULL AND v_firstname <> '' AND
            v_industry  IS NOT NULL AND
            v_role      IS NOT NULL AND
            v_team_size IS NOT NULL
        );

        SELECT
            _session_id AS session_id,
            v_completed AS is_completed,
            CASE WHEN v_completed THEN 'completed' ELSE 'incomplete' END AS status,
            JSON_OBJECT(
                'step1_name',       (v_firstname IS NOT NULL AND v_firstname <> ''),
                'step2_industry',   (v_industry  IS NOT NULL),
                'step3_role',       (v_role      IS NOT NULL),
                'step4_team_size',  (v_team_size IS NOT NULL),
                'step5_intent',     (v_intent    IS NOT NULL),
                'step6_tools',      (v_tools     IS NOT NULL),
                'step6_challenges', (v_challenges IS NOT NULL)
            ) AS steps_completed;
    END IF;
END$$

DELIMITER ;
