#!/usr/bin/env bash
# The usage-timing views (ux-views.sql) in database otel, sent through the IAP tunnel
# (telemetry/tunnel.sh, localhost:18123) as admin. Safe to run again: every view is CREATE OR
# REPLACE. The admin password is read from Secret Manager and never printed.
set -euo pipefail
source "$(dirname "$0")/../gcp/env.sh"
URL=${CLICKHOUSE_URL:-http://localhost:18123/}
ADMIN=$(g secrets versions access latest --secret ch-admin-password)
SQL="$(dirname "$0")/ux-views.sql"

# Statements end with a line holding only ';' (the HTTP interface takes one statement at a time).
statement=""
count=0
while IFS= read -r line || [ -n "$line" ]; do
    if [ "$line" = ";" ]; then
        count=$((count + 1))
        if ! answer=$(printf '%s' "$statement" | curl -sS --fail-with-body -u "admin:$ADMIN" "$URL" --data-binary @-); then
            echo "Statement $count failed: $(printf '%s' "$statement" | grep -m1 -o 'VIEW [a-z_.]*')" >&2; echo "$answer" | head -c 2000 >&2; exit 1
        fi
        statement=""
    else
        statement+="$line"$'\n'
    fi
done < "$SQL"
echo "$count usage-timing views ready in otel"
