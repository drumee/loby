-- File: loby/schemas/procedures/save_onboarding_invites.sql
--
-- Records the invite step's answer on the onboarding row: the addresses that
-- contact/invite actually accepted.
--
-- The list is written whole, not appended to, because the caller sends the
-- complete set it has sent so far — a wizard where the user invites one person,
-- then adds two more and sends again, ends with all three in one array rather
-- than three rows of history. An empty array is a real answer ("skipped without
-- inviting anyone") and overwrites, exactly as it does for tools and
-- challenges.
--
-- Addresses are stored as given, minus blanks and duplicates. No format check:
-- the address has already been through the service's regex AND been accepted by
-- contact/invite by the time it reaches here, so a second, differently-spelled
-- rule could only ever disagree with the one that mattered.

DROP PROCEDURE IF EXISTS `save_onboarding_invites`;

DELIMITER $$

CREATE PROCEDURE `save_onboarding_invites`(
    IN _session_id   VARCHAR(128) CHARACTER SET ascii,
    IN _uid          VARCHAR(16)  CHARACTER SET ascii,
    IN _invites_json JSON
)
BEGIN
    DECLARE _rid  INT UNSIGNED;
    DECLARE _out  JSON DEFAULT JSON_ARRAY();
    DECLARE _val  VARCHAR(255);
    DECLARE _i    INT DEFAULT 0;
    DECLARE _len  INT DEFAULT 0;

    IF _invites_json IS NOT NULL AND JSON_VALID(_invites_json) = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invites must be valid JSON';
    END IF;

    IF _invites_json IS NOT NULL AND JSON_TYPE(_invites_json) <> 'ARRAY' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invites must be a JSON array';
    END IF;

    IF _invites_json IS NOT NULL THEN
        SET _len = JSON_LENGTH(_invites_json);
        WHILE _i < _len DO
            SET _val = TRIM(COALESCE(JSON_VALUE(_invites_json, CONCAT('$[', _i, ']')), ''));
            -- Skip blanks, and anything already collected: the client accumulates
            -- across sends, so a retry of a partial failure can legitimately
            -- present an address the previous call already stored.
            IF _val <> '' AND JSON_SEARCH(_out, 'one', _val) IS NULL THEN
                SET _out = JSON_ARRAY_APPEND(_out, '$', _val);
            END IF;
            SET _i = _i + 1;
        END WHILE;
    END IF;

    CALL onboarding_resolve_row(_session_id, _uid, 1, _rid);

    UPDATE onboarding_responses
    SET invites = _out,
        mtime   = UNIX_TIMESTAMP()
    WHERE id = _rid;
END$$

DELIMITER ;
