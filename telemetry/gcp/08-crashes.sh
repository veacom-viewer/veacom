#!/usr/bin/env bash
# Ship only the validator and server. No viewer profiles, test studies, local credentials or dependency installs.
set -euo pipefail
source "$(dirname "$0")/env.sh"
root=$(cd "$(dirname "$0")/../.." && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/electron" "$stage/telemetry/crashes"
cp "$root/electron/crash-schema.cjs" "$stage/electron/"
cp "$root/telemetry/crashes/server.cjs" "$stage/telemetry/crashes/"
cp "$root/telemetry/crashes/Dockerfile" "$stage/"
service=veacom-crashes
sa="crash-intake@$PROJECT.iam.gserviceaccount.com"
g services enable cloudbuild.googleapis.com artifactregistry.googleapis.com run.googleapis.com
if ! g iam service-accounts describe "$sa" >/dev/null 2>&1; then
  g iam service-accounts create crash-intake --display-name="VEAcom crash intake"
fi
# Exclude request logs before either service can receive traffic. These logs carry IPs and URLs.
exclude_requests() {
  local name=$1 service_name=$2 filter
  filter="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$service_name\" AND logName:\"run.googleapis.com%2Frequests\""
  if ! g logging sinks describe _Default --format=json | python3 -c 'import json,sys; name,f=sys.argv[1:]; sys.exit(not any(x.get("name")==name and x.get("filter")==f and not x.get("disabled") for x in json.load(sys.stdin).get("exclusions",[])))' "$name" "$filter"; then
    g logging sinks update _Default --add-exclusion="name=$name,filter=$filter" >/dev/null
  fi
}

storage=veacom-crash-storage
exclude_requests crash-requests "$service"
exclude_requests crash-storage-requests "$storage"

collector_sa="otel-collector@$PROJECT.iam.gserviceaccount.com"
config="$root/telemetry/collector/crashes.yaml"
if g secrets describe otel-crashes-config >/dev/null 2>&1; then
  g secrets versions add otel-crashes-config --data-file="$config" >/dev/null
else
  g secrets create otel-crashes-config --replication-policy=user-managed --locations="$REGION" --data-file="$config" >/dev/null
fi
g secrets add-iam-policy-binding otel-crashes-config --member="serviceAccount:$collector_sa" --role=roles/secretmanager.secretAccessor >/dev/null
g run deploy "$storage" --image="$COLLECTOR_IMAGE" --region="$REGION" --service-account="$collector_sa" \
  --invoker-iam-check --no-allow-unauthenticated --port=8080 --cpu=1 --memory=512Mi --min-instances=0 --max-instances=1 \
  --network=veacom-net --subnet=veacom-london --vpc-egress=private-ranges-only \
  --set-secrets="CH_PASSWORD=ch-collector-password:latest,/etc/otelcol/crashes.yaml=otel-crashes-config:latest" \
  --args=--config=/etc/otelcol/crashes.yaml --labels=app=veacom,purpose=crashes --quiet
g run services add-iam-policy-binding "$storage" --region="$REGION" --member="serviceAccount:$sa" --role=roles/run.invoker >/dev/null
storage_url=$(g run services describe "$storage" --region="$REGION" --format='value(status.url)')

# The viewer's URL stays the same. Deploy the public collector's reserved-service filter only after this cutover.
g run deploy "$service" --region="$REGION" --source="$stage" --service-account="$sa" --allow-unauthenticated \
  --port=8080 --cpu=1 --memory=256Mi --min-instances=0 --max-instances=1 --concurrency=20 --timeout=15 \
  --clear-secrets --set-env-vars="CRASH_STORAGE_URL=$storage_url" --labels=app=veacom,purpose=crashes --quiet
g run services update-traffic "$service" --region="$REGION" --to-latest --quiet

# Earlier intake revisions read the public collector token. The new revision only invokes private storage.
if g secrets get-iam-policy ingest-token --format=json | python3 -c '
import json,sys
sys.exit(not any(b["role"] == "roles/secretmanager.secretAccessor" and not b.get("condition") and sys.argv[1] in b.get("members", []) for b in json.load(sys.stdin).get("bindings", [])))
' "serviceAccount:$sa"; then
  g secrets remove-iam-policy-binding ingest-token --member="serviceAccount:$sa" --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
fi
