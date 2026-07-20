-- File: loby/schemas/procedures/save_onboarding_industry.sql

DROP PROCEDURE IF EXISTS `save_onboarding_industry`;

DELIMITER $$

CREATE PROCEDURE `save_onboarding_industry`(
    IN _session_id     VARCHAR(128) CHARACTER SET ascii,
    IN _industry       VARCHAR(32),
    IN _industry_other VARCHAR(255)
)
BEGIN
    IF _session_id IS NULL OR _session_id = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session_id is required';
    END IF;

    IF _industry NOT IN (
        'tech_software','creative_marketing','consulting_agency','legal_compliance',
        'finance_accounting','healthcare','education','real_estate',
        'ecommerce_retail','media_content','operations','other'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid industry value';
    END IF;

    UPDATE onboarding_responses
    SET industry       = _industry,
        industry_other = IF(_industry = 'other', NULLIF(TRIM(_industry_other), ''), NULL),
        mtime          = UNIX_TIMESTAMP()
    WHERE session_id = _session_id;

    IF ROW_COUNT() = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Onboarding session not found. Start at step 1.';
    END IF;
END$$

DELIMITER ;
