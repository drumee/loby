-- File: loby/schemas/procedures/save_onboarding_intent.sql
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

    IF _intent NOT IN (
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
