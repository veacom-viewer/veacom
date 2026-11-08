#!/usr/bin/env bash
# Passwords and the ingest token, made straight into Secret Manager (kept in London) and
# never printed; and the two service accounts that may read them.
set -euo pipefail
source "$(dirname "$0")/env.sh"

for name in ch-admin-password ch-collector-password ch-agent-password ingest-token; do
    if ! g secrets describe "$name" >/dev/null 2>&1; then
        openssl rand -base64 48 | tr -d '\n/+=' | head -c 40 |
            g secrets create "$name" --replication-policy=user-managed --locations="$REGION" --data-file=- >/dev/null
    fi
done

account() { echo "$1@$PROJECT.iam.gserviceaccount.com"; }
g iam service-accounts describe "$(account clickhouse-vm)" >/dev/null 2>&1 ||
    g iam service-accounts create clickhouse-vm --display-name="ClickHouse VM"
g iam service-accounts describe "$(account otel-collector)" >/dev/null 2>&1 ||
    g iam service-accounts create otel-collector --display-name="OpenTelemetry collector"

grant() { g secrets add-iam-policy-binding "$1" --member="serviceAccount:$(account "$2")" \
    --role=roles/secretmanager.secretAccessor >/dev/null; }
grant ch-admin-password clickhouse-vm
grant ch-collector-password otel-collector
grant ingest-token otel-collector
g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$(account clickhouse-vm)" \
    --role=roles/logging.logWriter --condition=None >/dev/null
