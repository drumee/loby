-- File: loby/schemas/procedures/save_onboarding_industry.sql
--
-- v3: resolves its target row via onboarding_resolve_row with _create = 1.
-- Previously a bare UPDATE that raised "Onboarding session not found" whenever
-- step 1 had not landed or the session had rotated — which permanently wedged
-- the wizard. Signature gains _uid in position 2.

DROP PROCEDURE IF EXISTS `save_onboarding_industry`;

DELIMITER $$

CREATE PROCEDURE `save_onboarding_industry`(
    IN _session_id     VARCHAR(128) CHARACTER SET ascii,
    IN _uid            VARCHAR(16)  CHARACTER SET ascii,
    IN _industry       VARCHAR(32),
    IN _industry_other VARCHAR(255)
)
BEGIN
    DECLARE _rid INT UNSIGNED;

    IF _industry NOT IN (
        'tech_software','creative_marketing','consulting_agency','legal_compliance',
        'finance_accounting','healthcare','education','real_estate',
        'ecommerce_retail','media_content','operations','other'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid industry value';
    END IF;

    CALL onboarding_resolve_row(_session_id, _uid, 1, _rid);

    UPDATE onboarding_responses
    SET industry       = _industry,
        industry_other = IF(_industry = 'other', NULLIF(TRIM(_industry_other), ''), NULL),
        mtime          = UNIX_TIMESTAMP()
    WHERE id = _rid;
END$$

DELIMITER ;
