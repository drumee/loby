-- Reward Hub: save referral relationship
DELIMITER $$

DROP PROCEDURE IF EXISTS `reward_save_referral`$$

CREATE PROCEDURE `reward_save_referral`(
  IN _referral_code VARCHAR(6),
  IN _invitee_id VARCHAR(64)
)
BEGIN
  DECLARE _referrer_id VARCHAR(64) DEFAULT NULL;
  
  -- Find referrer_id from referral_code
  SELECT user_id INTO _referrer_id 
  FROM user_referral_code 
  WHERE referral_code = _referral_code
  LIMIT 1;
  
  -- If valid referrer found, insert into referral table
  IF _referrer_id IS NOT NULL AND _referrer_id != _invitee_id THEN
    INSERT INTO referral (
      referrer_id, 
      invitee_id, 
      referral_code, 
      status
    ) VALUES (
      _referrer_id,
      _invitee_id,
      _referral_code,
      'pending'
    )
    ON DUPLICATE KEY UPDATE 
      updated_at = CURRENT_TIMESTAMP;
    
    SELECT _referrer_id AS referrer_id, 'success' AS status;
  ELSE
    SELECT NULL AS referrer_id, 'invalid_code' AS status;
  END IF;
END$$

DELIMITER ;
