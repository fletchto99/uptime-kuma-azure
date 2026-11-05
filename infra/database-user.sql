-- Run privately as the server administrator with VERIFY_IDENTITY TLS.
-- Replace the placeholder privately; never save the real password in this repo.
-- Use the same runtime password supplied to the secure Bicep parameter.
CREATE USER 'kuma'@'%' IDENTIFIED BY 'REPLACE_PRIVATELY' REQUIRE SSL;
GRANT ALL PRIVILEGES ON `kuma`.* TO 'kuma'@'%';
