#!/usr/bin/env bash
# Opens the secure tunnel to ClickHouse: localhost:18123 on this computer is ClickHouse's
# HTTP port on the VM, which has no public address. Leave it running while querying.
set -euo pipefail
source "$(dirname "$0")/gcp/env.sh"
exec gcloud compute start-iap-tunnel clickhouse 8123 --local-host-port=localhost:18123 \
    --zone="$ZONE" --project="$PROJECT" --account="$ACCOUNT"
