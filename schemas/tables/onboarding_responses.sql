-- File: loby/schemas/tables/onboarding_responses.sql

DROP TABLE IF EXISTS onboarding_responses;

CREATE TABLE IF NOT EXISTS onboarding_responses (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    session_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL
        COMMENT 'Unique session identifier',

    -- Stable owner. session_id rotates (re-login / token refresh / expiry);
    -- uid does not, so it is what onboarding_resolve_row falls back to in
    -- order to recover a user's answers after a session change.
    uid VARCHAR(16) CHARACTER SET ascii COLLATE ascii_general_ci NULL
        COMMENT 'Stable owner (yp.drumate.id). Survives session rotation.',

    -- Step 1: name
    firstname VARCHAR(128) NOT NULL,

    -- Carried over from signup (signup_data) or kept for legacy v1 clients
    lastname     VARCHAR(128) NULL,
    email        VARCHAR(255) NULL,
    country_code CHAR(2)      NULL COMMENT 'Corresponds to countries.country_code',

    -- Step 2: kind of work
    industry VARCHAR(32) NULL
        COMMENT 'tech_software | creative_marketing | consulting_agency | legal_compliance | finance_accounting | healthcare | education | real_estate | ecommerce_retail | media_content | operations | other',
    industry_other VARCHAR(255) NULL
        COMMENT 'Free-text value when industry = other',

    -- Step 3: role
    role VARCHAR(32) NULL
        COMMENT 'founder_ceo | manager_team_lead | executive_associate | freelancer_consultant | other',
    role_other VARCHAR(255) NULL
        COMMENT 'Free-text value when role = other',

    -- Step 4: team size (replaces v1 usage_plan)
    team_size ENUM('just_me','2_10','10_50','50_plus') NULL,

    -- Step 5: workspace intent (optional, "Tell me later")
    intent VARCHAR(32) NULL
        COMMENT 'manage_projects | work_with_clients | store_sensitive | build_workflows | personal_files',

    -- Step 6: tools + challenges (optional, "Tell me later")
    current_tools  JSON          NULL COMMENT 'Array of canonical tool keys selected by the user',
    tools_other    VARCHAR(255)  NULL COMMENT 'Free-text value when current_tools contains "other"',
    challenges     JSON          NULL COMMENT 'Array of pain-point keys selected on the tools step',
    challenge_note VARCHAR(1024) NULL COMMENT 'Free-text "Tell me more" note',

    -- Step 8: teammates invited from the wizard.
    --
    -- What was actually SENT, not what was staged: an address only lands here
    -- once contact/invite has accepted it, so the column answers "who did this
    -- user bring in during onboarding" rather than "what did they type". The
    -- invitations themselves live in contacts; this is the onboarding record of
    -- them, which is what the funnel export and the activation checks read.
    invites JSON NULL COMMENT 'Array of email addresses successfully invited at the invite step',

    -- Legacy v1 fields, retained for back-compat with the old wizard
    usage_plan            JSON             NULL COMMENT 'v1: personal | startup | enterprise',
    privacy_concern_level TINYINT UNSIGNED NULL COMMENT 'v1 only: 1..5',

    -- Metadata
    ctime INT(11) UNSIGNED,
    mtime INT(11) UNSIGNED,

    INDEX idx_session_id (session_id),
    INDEX idx_email      (email),
    -- Non-unique on purpose: a user may hold a legacy anonymous row alongside
    -- the current one. onboarding_resolve_row picks the most recently touched.
    INDEX idx_uid        (uid),

    UNIQUE KEY uni_session_id (session_id),

    CHECK (privacy_concern_level IS NULL OR privacy_concern_level BETWEEN 1 AND 5)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Onboarding survey responses linked to session ID';
