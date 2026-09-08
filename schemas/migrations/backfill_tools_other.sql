-- File: loby/schemas/migrations/backfill_tools_other.sql
--
-- One-shot, idempotent data migration. Requires alter_onboarding_responses_identity.sql.
--
-- WHY
-- ---
-- Before this change the tools step stored a user's custom "Other" text by
-- REPLACING the "other" marker with the raw string inside the current_tools
-- JSON array (see onboarding-ui app/lib/other-option.js buildToolsPayload).
-- That made the array a mix of canonical keys and free text, so no consumer
-- could tell "the user picked Notion" from "the user typed Notion" — and the
-- analytics export flattened both into the same cell.
--
-- This walks existing rows, moves any non-canonical entry out to the new
-- tools_other column, and puts the canonical "other" marker back in the array,
-- bringing legacy records in line with the industry/role model.
--
-- Idempotent by construction: it only touches rows where tools_other IS NULL
-- (i.e. not yet migrated) AND a non-canonical entry is actually present. A
-- second run finds nothing to do. Rows whose arrays are already clean are
-- left untouched, so no mtime churn.

DROP PROCEDURE IF EXISTS `_ob_backfill_tools_other`;

DELIMITER $$

CREATE PROCEDURE `_ob_backfill_tools_other`()
BEGIN
    DECLARE _done    INT DEFAULT 0;
    DECLARE _id      INT UNSIGNED;
    DECLARE _tools   JSON;
    DECLARE _out     JSON;
    DECLARE _custom  VARCHAR(255);
    DECLARE _val     VARCHAR(255);
    DECLARE _i       INT;
    DECLARE _len     INT;
    DECLARE _has_other TINYINT;

    DECLARE cur CURSOR FOR
        SELECT id, current_tools
        FROM onboarding_responses
        WHERE tools_other IS NULL
          AND current_tools IS NOT NULL
          AND JSON_VALID(current_tools)
          AND JSON_TYPE(current_tools) = 'ARRAY'
          AND JSON_LENGTH(current_tools) > 0;

    DECLARE CONTINUE HANDLER FOR NOT FOUND SET _done = 1;

    OPEN cur;
    scan: LOOP
        FETCH cur INTO _id, _tools;
        IF _done = 1 THEN
            LEAVE scan;
        END IF;

        SET _out       = JSON_ARRAY();
        SET _custom    = NULL;
        SET _has_other = 0;
        SET _i         = 0;
        SET _len       = JSON_LENGTH(_tools);

        WHILE _i < _len DO
            SET _val = JSON_VALUE(_tools, CONCAT('$[', _i, ']'));
            IF _val IS NOT NULL AND _val <> '' THEN
                IF _val IN ('google_drive','notion','slack','dropbox',
                            'clickup','trello','jira') THEN
                    SET _out = JSON_ARRAY_APPEND(_out, '$', _val);
                ELSEIF _val = 'other' THEN
                    SET _has_other = 1;
                ELSE
                    -- Non-canonical entry: this is the user's free text.
                    -- Keep the first one; extra entries are unreachable via
                    -- the UI (a single "Other" input) but concatenating would
                    -- corrupt the value, so later ones are dropped.
                    IF _custom IS NULL THEN
                        SET _custom = _val;
                    END IF;
                    SET _has_other = 1;
                END IF;
            END IF;
            SET _i = _i + 1;
        END WHILE;

        IF _has_other = 1 THEN
            SET _out = JSON_ARRAY_APPEND(_out, '$', 'other');
        END IF;

        -- Only rewrite rows that actually carried free text. A row that merely
        -- held canonical keys is already correct and must not be re-stamped.
        IF _custom IS NOT NULL THEN
            UPDATE onboarding_responses
            SET current_tools = _out,
                tools_other   = _custom
            WHERE id = _id;
        END IF;
    END LOOP;
    CLOSE cur;
END$$

DELIMITER ;

CALL `_ob_backfill_tools_other`();

DROP PROCEDURE `_ob_backfill_tools_other`;
