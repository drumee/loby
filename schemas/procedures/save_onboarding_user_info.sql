-- File: loby/schemas/procedures/save_onboarding_user_info.sql
--
-- v2: only firstname is required. lastname/email/country_code are now
-- collected at signup (signup_data) and become optional pass-through args
-- so the legacy v1 wizard keeps working during rollout.

DROP PROCEDURE IF EXISTS `save_onboarding_user_info`;

DELIMITER $$

CREATE PROCEDURE `save_onboarding_user_info`(
    IN _session_id   VARCHAR(128) CHARACTER SET ascii,
    IN _firstname    VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN _lastname     VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN _email        VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN _country_code CHAR(2)      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
)
BEGIN
    IF _session_id IS NULL OR _session_id = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session_id is required';
    END IF;

    IF _firstname IS NULL OR _firstname = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'firstname is required';
    END IF;

    IF _email IS NOT NULL AND _email <> ''
       AND _email NOT REGEXP '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid email format';
    END IF;

    IF _country_code IS NOT NULL AND _country_code <> '' AND LENGTH(_country_code) <> 2 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'country_code must be 2 letters';
    END IF;

    INSERT INTO onboarding_responses (
        session_id,
        firstname,
        lastname,
        email,
        country_code,
        ctime,
        mtime
    )
    VALUES (
        _session_id,
        _firstname,
        NULLIF(_lastname, ''),
        NULLIF(_email, ''),
        NULLIF(_country_code, ''),
        UNIX_TIMESTAMP(),
        UNIX_TIMESTAMP()
    )
    ON DUPLICATE KEY UPDATE
        firstname    = VALUES(firstname),
        lastname     = COALESCE(VALUES(lastname),     lastname),
        email        = COALESCE(VALUES(email),        email),
        country_code = COALESCE(VALUES(country_code), country_code),
        mtime        = UNIX_TIMESTAMP();
END$$

DELIMITER ;
