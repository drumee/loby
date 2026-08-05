-- File: loby/schemas/procedures/reset_onboarding_response.sql
--
-- NEW in v3. Backs onboarding.reset().
--
-- WHY
-- ---
-- reset() used to call output.clearAuthorization() and nothing else: it threw
-- away the SESSION but kept the DATA. The user got a brand new session id, the
-- half-filled onboarding_responses row stayed behind keyed to the old one, and
-- nothing could ever reach it again — an orphan per reset, and a wizard that
-- restarted against a dead session.
--
-- A reset should clear the user's onboarding answers. It should NOT destroy
-- their login: the wizard runs inside an authenticated desk session, and
-- dropping that is what produced the dead-session restart.
--
-- Deletes every row belonging to the user (not just the resolved one) so a
-- reset also collects orphans left behind by the old implementation. Falls
-- back to the session row when there is no uid, which is the legacy shape.
-- Returns the number of rows removed.

DROP PROCEDURE IF EXISTS `reset_onboarding_response`;

DELIMITER $$

CREATE PROCEDURE `reset_onboarding_response`(
    IN _session_id VARCHAR(128) CHARACTER SET ascii,
    IN _uid        VARCHAR(16)  CHARACTER SET ascii
)
BEGIN
    DECLARE _removed INT DEFAULT 0;

    SET _uid        = NULLIF(TRIM(COALESCE(_uid, '')), '');
    SET _session_id = NULLIF(TRIM(COALESCE(_session_id, '')), '');

    IF _session_id IS NULL AND _uid IS NULL THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'session_id or uid is required';
    END IF;

    DELETE FROM onboarding_responses
    WHERE (_uid IS NOT NULL AND uid = _uid)
       OR (_session_id IS NOT NULL AND session_id = _session_id);

    SET _removed = ROW_COUNT();

    SELECT _removed AS removed, 'reset' AS status;
END$$

DELIMITER ;
