#!/bin/bash
# Runs once, on first boot of an empty data directory.
# One database, one schema + one login role per service; roles see only their own schema.
set -euo pipefail

: "${USER_SERVICE_DB_PASSWORD:?}" "${TRIP_SERVICE_DB_PASSWORD:?}" "${MATCHING_SERVICE_DB_PASSWORD:?}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE DATABASE ridesharing;
REVOKE ALL ON DATABASE ridesharing FROM PUBLIC;
-- Service roles may connect to ridesharing only.
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
SQL

# Passwords are passed as psql variables (not interpolated by the shell) and quoted with :'name'.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname ridesharing \
  -v user_pw="$USER_SERVICE_DB_PASSWORD" \
  -v trip_pw="$TRIP_SERVICE_DB_PASSWORD" \
  -v matching_pw="$MATCHING_SERVICE_DB_PASSWORD" <<'SQL'
CREATE ROLE user_service LOGIN PASSWORD :'user_pw';
CREATE ROLE trip_service LOGIN PASSWORD :'trip_pw';
CREATE ROLE matching_service LOGIN PASSWORD :'matching_pw';

GRANT CONNECT ON DATABASE ridesharing TO user_service, trip_service, matching_service;

-- Nobody but the owner uses public.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA user_service AUTHORIZATION user_service;
CREATE SCHEMA trip_service AUTHORIZATION trip_service;
CREATE SCHEMA matching_service AUTHORIZATION matching_service;

ALTER ROLE user_service SET search_path = user_service;
ALTER ROLE trip_service SET search_path = trip_service, postgis;
ALTER ROLE matching_service SET search_path = matching_service;

-- PostGIS lives in its own schema; only trip_service may use it.
CREATE SCHEMA postgis;
CREATE EXTENSION postgis SCHEMA postgis;
REVOKE ALL ON SCHEMA postgis FROM PUBLIC;
GRANT USAGE ON SCHEMA postgis TO trip_service;
GRANT SELECT ON ALL TABLES IN SCHEMA postgis TO trip_service;
SQL
