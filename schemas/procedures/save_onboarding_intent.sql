-- File: loby/schemas/procedures/save_onboarding_intent.sql
--
-- v4: an empty value CLEARS the column instead of being rejected.
--
-- The intent step is optional — the UI offers "Tell me later" — and that button
-- now records "no answer" rather than walking past the step, so that a user who
-- had picked a goal and changed their mind can actually retract it. Previously
-- '' fell through to the enum check and raised 'Invalid intent value', so there
-- was no way to clear a stored intent at all: the wizard said "later" and the
-- row kept the old goal indefinitely.
--
-- NULL and whitespace are treated the same as '' so it cannot matter whether a
-- client omits the field, sends it empty, or sends a stray space. A non-empty
-- value is still validated against the same five keys as before.
--
-- v3: resolves its target row via onboarding_resolve_row with _create = 1
-- (see save_onboarding_industry.sql for the rationale). Signature gains _uid
-- in position 2.

DROP PROCEDURE IF EXISTS `save_onboarding_intent`;

DELIMITER $$

CREATE PROCEDURE `save_onboarding_intent`(
    IN _session_id VARCHAR(128) CHARACTER SET ascii,
    IN _uid        VARCHAR(16)  CHARACTER SET ascii,
    IN _intent     VARCHAR(32)
)
BEGIN
    DECLARE _rid INT UNSIGNED;

    SET _intent = NULLIF(TRIM(COALESCE(_intent, '')), '');

    IF _intent IS NOT NULL AND _intent NOT IN (
        'manage_projects','work_with_clients','store_sensitive',
        'build_workflows','personal_files'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid intent value';
    END IF;

    CALL onboarding_resolve_row(_session_id, _uid, 1, _rid);

    UPDATE onboarding_responses
    SET intent = _intent,
        mtime  = UNIX_TIMESTAMP()
    WHERE id = _rid;
END$$

DELIMITER ;
