-- File: loby/schemas/procedures/save_onboarding_user_info.sql
--
-- v3: row is located via onboarding_resolve_row (uid-aware) instead of an
-- INSERT ... ON DUPLICATE KEY on session_id. Signature gains _uid in position
-- 2; all other parameters and all write semantics are unchanged.
--
-- v2: only firstname is required. lastname/email/country_code are collected at
-- signup (signup_data) and remain optional pass-through args so the legacy v1
-- wizard keeps working.

DROP PROCEDURE IF EXISTS `save_onboarding_user_info`;

DELIMITER $$

CREATE PROCEDURE `save_onboarding_user_info`(
    IN _session_id   VARCHAR(128) CHARACTER SET ascii,
    IN _uid          VARCHAR(16)  CHARACTER SET ascii,
    IN _firstname    VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN _lastname     VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN _email        VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN _country_code CHAR(2)      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
)
BEGIN
    DECLARE _rid INT UNSIGNED;

    -- Normalise BEFORE validating. The format check is anchored (^...$), so a
    -- single stray space made it reject an address that is otherwise perfectly
    -- valid. Seen in production:
    --   save_onboarding_user_info(..., 'exadim349@gmail.com ', ...)
    --                                                      ^ trailing space
    --   -> SIGNAL 'Invalid email format', and step 1 could never be saved.
    -- The address is not typed into the wizard: it is carried over from signup
    -- or backfilled from the account profile, so the user has no field to
    -- correct and no way out. Trimming is the fix; rejecting is not.
    -- REGEXP_REPLACE, not TRIM: bare TRIM() strips spaces only, so a tab or a
    -- newline picked up from a paste or an import would survive and still fail
    -- the anchored check below. [[:space:]] covers space, tab, CR and LF.
    SET _firstname    = REGEXP_REPLACE(COALESCE(_firstname, ''),    '^[[:space:]]+|[[:space:]]+$', '');
    SET _lastname     = NULLIF(REGEXP_REPLACE(COALESCE(_lastname, ''),     '^[[:space:]]+|[[:space:]]+$', ''), '');
    SET _email        = NULLIF(REGEXP_REPLACE(COALESCE(_email, ''),        '^[[:space:]]+|[[:space:]]+$', ''), '');
    SET _country_code = NULLIF(REGEXP_REPLACE(COALESCE(_country_code, ''), '^[[:space:]]+|[[:space:]]+$', ''), '');

    IF _firstname = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'firstname is required';
    END IF;

    IF _email IS NOT NULL
       AND _email NOT REGEXP '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid email format';
    END IF;

    IF _country_code IS NOT NULL AND LENGTH(_country_code) <> 2 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'country_code must be 2 letters';
    END IF;

    CALL onboarding_resolve_row(_session_id, _uid, 1, _rid);

    -- COALESCE(new, existing) reproduces exactly the ON DUPLICATE KEY UPDATE
    -- semantics this procedure had: a NULL argument never erases a stored
    -- value (these fields arrive from signup, not from the wizard).
    UPDATE onboarding_responses
    SET firstname    = _firstname,
        lastname     = COALESCE(_lastname,     lastname),
        email        = COALESCE(_email,        email),
        country_code = COALESCE(_country_code, country_code),
        mtime        = UNIX_TIMESTAMP()
    WHERE id = _rid;
END$$

DELIMITER ;
