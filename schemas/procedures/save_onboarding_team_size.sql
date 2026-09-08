-- File: loby/schemas/procedures/save_onboarding_team_size.sql
--
-- v3: resolves its target row via onboarding_resolve_row with _create = 1
-- (see save_onboarding_industry.sql for the rationale). Signature gains _uid
-- in position 2.

DROP PROCEDURE IF EXISTS `save_onboarding_team_size`;

DELIMITER $$

CREATE PROCEDURE `save_onboarding_team_size`(
    IN _session_id VARCHAR(128) CHARACTER SET ascii,
    IN _uid        VARCHAR(16)  CHARACTER SET ascii,
    IN _team_size  VARCHAR(16)
)
BEGIN
    DECLARE _rid INT UNSIGNED;

    IF _team_size NOT IN ('just_me','2_10','10_50','50_plus') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid team_size. Must be just_me|2_10|10_50|50_plus';
    END IF;

    CALL onboarding_resolve_row(_session_id, _uid, 1, _rid);

    UPDATE onboarding_responses
    SET team_size = _team_size,
        mtime     = UNIX_TIMESTAMP()
    WHERE id = _rid;
END$$

DELIMITER ;
