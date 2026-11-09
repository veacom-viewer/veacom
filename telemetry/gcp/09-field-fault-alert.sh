#!/usr/bin/env bash
# Create or update the field fault policy for one existing Cloud Monitoring notification channel.
set -euo pipefail
source "$(dirname "$0")/env.sh"

if [[ $# != 1 || ! $1 =~ ^projects/${PROJECT}/notificationChannels/[0-9]+$ ]]; then
  echo "Usage: $0 projects/$PROJECT/notificationChannels/CHANNEL_ID" >&2
  exit 2
fi
channel=$1
file=$(mktemp)
trap 'rm -f "$file"' EXIT
cat > "$file" <<EOF
displayName: VEAcom field fault recorded
userLabels:
  veacom_alert: field_fault
enabled: true
combiner: OR
conditions:
  - displayName: Field fault stored
    conditionMatchedLog:
      filter: >-
        resource.type="cloud_run_revision" AND resource.labels.project_id="$PROJECT"
        AND resource.labels.service_name="veacom-crashes"
        AND log_id("run.googleapis.com/stdout") AND jsonPayload.event="veacom.field_fault_stored"
alertStrategy:
  notificationRateLimit:
    period: 3600s
  autoClose: 86400s
notificationChannels:
  - $channel
documentation:
  mimeType: text/markdown
  content: >-
    VEAcom stored a desktop field fault. Run the read-only telemetry/crashes/triage.cjs
    command through the ClickHouse tunnel to inspect unique incidents and recovery outcomes.
EOF

existing=$(g alpha monitoring policies list --format=json | python3 -c '
import json, sys
for policy in json.load(sys.stdin):
    if policy.get("userLabels", {}).get("veacom_alert") == "field_fault":
        print(policy["name"])
')
if [[ -z $existing ]]; then
  g alpha monitoring policies create --policy-from-file="$file"
elif [[ $existing == *$'\n'* ]]; then
  echo 'Several alert policies have the field_fault label. Select one in Cloud Monitoring before rerunning setup.' >&2
  exit 1
else
  g alpha monitoring policies update "$existing" --policy-from-file="$file"
fi
