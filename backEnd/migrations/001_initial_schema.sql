CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(254) NOT NULL,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NULL,
  google_sub VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_google_sub (google_sub)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS medical_profiles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  date_of_birth DATE NOT NULL,
  sex VARCHAR(30) NOT NULL,
  blood_type VARCHAR(10) NOT NULL,
  allergies TEXT NOT NULL,
  medications TEXT NOT NULL,
  diseases TEXT NOT NULL,
  surgeries TEXT NOT NULL,
  public_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  public_password_hash VARCHAR(255) NULL,
  public_access_version INT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_medical_profiles_user_id (user_id),
  UNIQUE KEY uq_medical_profiles_public_token (public_token),
  CONSTRAINT fk_medical_profiles_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS emergency_contacts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  medical_profile_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(160) NOT NULL,
  phone VARCHAR(40) NOT NULL,
  relationship VARCHAR(50) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_emergency_contacts_profile_id (medical_profile_id),
  CONSTRAINT fk_emergency_contacts_profile
    FOREIGN KEY (medical_profile_id) REFERENCES medical_profiles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash BINARY(32) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_password_reset_tokens_hash (token_hash),
  KEY ix_password_reset_tokens_user_id (user_id),
  CONSTRAINT fk_password_reset_tokens_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope ENUM('account', 'public') NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  medical_profile_id BIGINT UNSIGNED NULL,
  public_access_version INT UNSIGNED NULL,
  token_hash BINARY(32) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_sessions_token_hash (token_hash),
  KEY ix_auth_sessions_user_id (user_id),
  KEY ix_auth_sessions_profile_id (medical_profile_id),
  CONSTRAINT fk_auth_sessions_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_auth_sessions_profile
    FOREIGN KEY (medical_profile_id) REFERENCES medical_profiles (id) ON DELETE CASCADE,
  CONSTRAINT chk_auth_sessions_scope CHECK (
    (scope = 'account' AND user_id IS NOT NULL AND medical_profile_id IS NULL AND public_access_version IS NULL)
    OR
    (scope = 'public' AND user_id IS NULL AND medical_profile_id IS NOT NULL AND public_access_version IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
