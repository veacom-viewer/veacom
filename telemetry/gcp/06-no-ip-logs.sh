#!/usr/bin/env bash
# Cloud Run logs every request with the sender's IP address. The collector's request logs are
# excluded from storage, so no IP address of a VEAcom user is kept anywhere (the collector
# itself never records them). Errors from the collector's own logs are still kept.
set -euo pipefail
source "$(dirname "$0")/env.sh"
FILTER='resource.type="cloud_run_revision" AND resource.labels.service_name="otel-collector" AND logName:"run.googleapis.com%2Frequests"'
g logging sinks update _Default --add-exclusion=name=collector-requests,filter="$FILTER" >/dev/null
# Anything logged before the exclusion (setup tests only) goes too.
g logging logs delete "projects/$PROJECT/logs/run.googleapis.com%2Frequests" --quiet >/dev/null 2>&1 || true
