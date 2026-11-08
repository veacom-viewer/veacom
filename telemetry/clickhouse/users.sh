#!/usr/bin/env bash
# ClickHouse's database and users, sent through the IAP tunnel (localhost:18123; see
# TELEMETRY.md). Safe to run again: passwords are re-read from Secret Manager, never printed.
#  - collector: writes the otel tables, from the private subnet only (Cloud Run's egress);
#  - agent: reads the otel tables and nothing else, with limits, through the tunnel only;
#  - admin: made by the container itself (gcp/vm-startup.sh).
# SCHEMA=create also lets the collector make its tables (its first start); SCHEMA=locked
# (the default) takes that back.
set -euo pipefail
source "$(dirname "$0")/../gcp/env.sh"
URL=${CLICKHOUSE_URL:-http://localhost:18123/}
ADMIN=$(g secrets versions access latest --secret ch-admin-password)
run() { printf '%s' "$1" | curl -sS --fail-with-body -u "admin:$ADMIN" "$URL" --data-binary @- >/dev/null; }
COLLECTOR=$(g secrets versions access latest --secret ch-collector-password)
AGENT=$(g secrets versions access latest --secret ch-agent-password)

run "CREATE DATABASE IF NOT EXISTS otel"
run "CREATE SETTINGS PROFILE OR REPLACE agent_profile SETTINGS readonly = 1, max_execution_time = 60,
     max_result_rows = 200000, max_memory_usage = 2000000000"

run "CREATE USER OR REPLACE collector IDENTIFIED WITH sha256_password BY '$COLLECTOR' HOST IP '10.10.0.0/24'"
run "GRANT INSERT, SELECT ON otel.* TO collector"
if [ "${SCHEMA:-locked}" = create ]; then
    run "GRANT CREATE DATABASE, CREATE TABLE, CREATE VIEW, ALTER ON otel.* TO collector"
fi

run "CREATE USER OR REPLACE agent IDENTIFIED WITH sha256_password BY '$AGENT' HOST IP '35.235.240.0/20'
     SETTINGS PROFILE 'agent_profile'"
run "GRANT SELECT ON otel.* TO agent"
run "CREATE QUOTA OR REPLACE agent_quota FOR INTERVAL 1 hour MAX queries = 2000 TO agent"
echo "users ready (collector may create tables: ${SCHEMA:-locked})"
