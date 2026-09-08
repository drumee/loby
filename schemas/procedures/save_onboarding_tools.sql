-- File: loby/schemas/procedures/save_onboarding_tools.sql
--
-- v3. Three changes, all root-cause fixes:
--
-- 1. Row resolution via onboarding_resolve_row (_create = 1), like every other
--    step. Signature gains _uid in position 2.
--
-- 2. An EMPTY selection is now a legal, meaningful value. It used to be
--    rejected ('current_tools is required'), and the client skipped the call
--    entirely when nothing was selected — so de-selecting every tool left the
--    previously saved list in place and the user's actual answer ("none of
--    these") could never be recorded. NULL / empty array now writes an empty
--    JSON array, which overwrites.
--
--    Empty array (answered: none) and SQL NULL (never answered) stay
--    distinguishable, which is what check_onboarding_completion reports on.
--
-- 3. The "Other" free text moves to the dedicated tools_other column, matching
--    industry_other / role_other. Normalisation happens HERE rather than only
--    in the client, so the invariant "current_tools contains canonical keys
--    only" holds no matter which client version is calling: a legacy client
--    that splices its raw string into the array still ends up with a clean
--    array plus a populated tools_other.
--
-- Legacy v1 JSON OBJECT payloads are still accepted and stored verbatim.

DROP PROCEDURE IF EXISTS `save_onboarding_tools`;

DELIMITER $$

CREATE PROCEDURE `save_onboarding_tools`(
    IN _session_id         VARCHAR(128) CHARACTER SET ascii,
    IN _uid                VARCHAR(16)  CHARACTER SET ascii,
    IN _current_tools_json JSON,
    IN _tools_other        VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
)
BEGIN
    DECLARE _rid       INT UNSIGNED;
    DECLARE _out       JSON;
    DECLARE _custom    VARCHAR(255) DEFAULT NULL;
    DECLARE _val       VARCHAR(255);
    DECLARE _i         INT DEFAULT 0;
    DECLARE _len       INT DEFAULT 0;
    DECLARE _has_other TINYINT DEFAULT 0;

    IF _current_tools_json IS NOT NULL AND JSON_VALID(_current_tools_json) = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'current_tools must be valid JSON';
    END IF;

    IF _current_tools_json IS NOT NULL
       AND JSON_TYPE(_current_tools_json) NOT IN ('ARRAY','OBJECT') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'current_tools must be a JSON array or object';
    END IF;

    SET _tools_other = NULLIF(TRIM(COALESCE(_tools_other, '')), '');

    IF _current_tools_json IS NULL THEN
        -- Explicit clear.
        SET _out = JSON_ARRAY();

    ELSEIF JSON_TYPE(_current_tools_json) = 'OBJECT' THEN
        -- Legacy v1 shape: stored verbatim, no normalisation to apply.
        SET _out = _current_tools_json;

    ELSE
        SET _out = JSON_ARRAY();
        SET _len = JSON_LENGTH(_current_tools_json);
        WHILE _i < _len DO
            SET _val = JSON_VALUE(_current_tools_json, CONCAT('$[', _i, ']'));
            IF _val IS NOT NULL AND _val <> '' THEN
                IF _val IN ('google_drive','notion','slack','dropbox',
                            'clickup','trello','jira') THEN
                    SET _out = JSON_ARRAY_APPEND(_out, '$', _val);
                ELSEIF _val = 'other' THEN
                    SET _has_other = 1;
                ELSE
                    -- Legacy client: raw free text spliced into the array.
                    IF _custom IS NULL THEN
                        SET _custom = _val;
                    END IF;
                    SET _has_other = 1;
                END IF;
            END IF;
            SET _i = _i + 1;
        END WHILE;

        -- An explicit tools_other argument wins over anything recovered from
        -- the array, so a current client is never second-guessed.
        SET _custom = COALESCE(_tools_other, _custom);

        -- "other" is only a real selection when it carries text; a bare marker
        -- with an empty input is dropped, mirroring the client-side rule in
        -- app/lib/other-option.js.
        IF _has_other = 1 AND _custom IS NOT NULL THEN
            SET _out = JSON_ARRAY_APPEND(_out, '$', 'other');
        ELSE
            SET _custom = NULL;
        END IF;
    END IF;

    CALL onboarding_resolve_row(_session_id, _uid, 1, _rid);

    UPDATE onboarding_responses
    SET current_tools = _out,
        tools_other   = _custom,
        mtime         = UNIX_TIMESTAMP()
    WHERE id = _rid;
END$$

DELIMITER ;
