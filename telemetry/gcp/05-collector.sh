#!/usr/bin/env bash
# The collector on Cloud Run: open to the internet (the app has no Google account), let in
# only with the ingest token; one instance at most; reaches ClickHouse over the private
# subnet (Direct VPC egress). Its configuration is kept in Secret Manager as a file.
# CREATE_SCHEMA=true for the very first start, so it makes its tables; then run again with
# the default (false) and `telemetry/clickhouse/users.sh` to take that right back.
set -euo pipefail
source "$(dirname "$0")/env.sh"
CONFIG="$(dirname "$0")/../collector/config.yaml"

# The public pipeline drops the crash service name. An older intake still sending here would receive a false success.
intake=$(g run services list --region="$REGION" --filter='metadata.name=veacom-crashes' --format='value(metadata.name)')
if [[ -n "$intake" ]]; then
    g run services describe "$intake" --region="$REGION" --format=json | python3 -c '
import json, sys
s = json.load(sys.stdin)
status = s["status"]
ready = status.get("latestReadyRevisionName")
uses_private_storage = any(e.get("name") == "CRASH_STORAGE_URL" and e.get("value") for e in s["spec"]["template"]["spec"]["containers"][0].get("env", []))
current_traffic = [t for t in status.get("traffic", []) if t.get("percent", 0) > 0]
if not (ready and ready == status.get("latestCreatedRevisionName") and uses_private_storage and current_traffic and all(t.get("revisionName") == ready for t in current_traffic)):
    sys.exit("Switch crash intake to private storage with 08-crashes.sh before updating the public collector.")
'
fi

if g secrets describe otelcol-config >/dev/null 2>&1; then
    g secrets versions add otelcol-config --data-file="$CONFIG" >/dev/null
else
    g secrets create otelcol-config --replication-policy=user-managed --locations="$REGION" \
        --data-file="$CONFIG" >/dev/null
fi
g secrets add-iam-policy-binding otelcol-config \
    --member="serviceAccount:otel-collector@$PROJECT.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor >/dev/null

g run deploy otel-collector --image="$COLLECTOR_IMAGE" --region="$REGION" \
    --service-account="otel-collector@$PROJECT.iam.gserviceaccount.com" \
    --allow-unauthenticated --port=8080 --cpu=1 --memory=512Mi --min-instances=0 --max-instances=1 \
    --network=veacom-net --subnet=veacom-london --vpc-egress=private-ranges-only \
    --set-secrets="INGEST_TOKEN=ingest-token:latest,CH_PASSWORD=ch-collector-password:latest,/etc/otelcol/config.yaml=otelcol-config:latest" \
    --set-env-vars="CREATE_SCHEMA=${CREATE_SCHEMA:-false}" \
    --args=--config=/etc/otelcol/config.yaml \
    --labels=app=veacom,purpose=telemetry --quiet
