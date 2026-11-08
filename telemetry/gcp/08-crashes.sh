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
# A newly created IAM service account can take a few seconds to reach Secret Manager.
for attempt in 1 2 3 4; do
  if g secrets add-iam-policy-binding ingest-token --member="serviceAccount:$sa" --role=roles/secretmanager.secretAccessor >/dev/null; then break; fi
  [[ $attempt -lt 4 ]] || exit 1
  sleep 5
done
# Cloud Run request logs carry IPs and URLs. Exclude them before the service receives any requests.
filter='resource.type="cloud_run_revision" AND resource.labels.service_name="veacom-crashes" AND logName:"run.googleapis.com%2Frequests"'
if ! g logging sinks describe _Default --format=json | python3 -c 'import json,sys; f=sys.argv[1]; sys.exit(not any(x.get("name")=="crash-requests" and x.get("filter")==f and not x.get("disabled") for x in json.load(sys.stdin).get("exclusions",[])))' "$filter"; then
  g logging sinks update _Default --add-exclusion="name=crash-requests,filter=$filter" >/dev/null
fi
g run deploy "$service" --region="$REGION" --source="$stage" --service-account="$sa" --allow-unauthenticated \
  --port=8080 --cpu=1 --memory=256Mi --min-instances=0 --max-instances=1 --concurrency=20 --timeout=15 \
  --set-secrets=INGEST_TOKEN=ingest-token:latest --labels=app=veacom,purpose=crashes --quiet
