-- File: loby/schemas/procedures/save_onboarding_role.sql
--
-- v3: resolves its target row via onboarding_resolve_row with _create = 1
-- (see save_onboarding_industry.sql for the rationale). Signature gains _uid
-- in position 2.

DROP PROCEDURE IF EXISTS `save_onboarding_role`;

DELIMITER $$

CREATE PROCEDURE `save_onboarding_role`(
    IN _session_id VARCHAR(128) CHARACTER SET ascii,
    IN _uid        VARCHAR(16)  CHARACTER SET ascii,
    IN _role       VARCHAR(32),
    IN _role_other VARCHAR(255)
)
BEGIN
    DECLARE _rid INT UNSIGNED;

    IF _role NOT IN (
        'founder_ceo','manager_team_lead','executive_associate',
        'freelancer_consultant','other'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid role value';
    END IF;

    CALL onboarding_resolve_row(_session_id, _uid, 1, _rid);

    UPDATE onboarding_responses
    SET role       = _role,
        role_other = IF(_role = 'other', NULLIF(TRIM(_role_other), ''), NULL),
        mtime      = UNIX_TIMESTAMP()
    WHERE id = _rid;
END$$

DELIMITER ;
