#!/usr/bin/env bash
# Runs a command with the collector's address and the ingest token in its environment
# (VEACOM_TELEMETRY_ENDPOINT, VEACOM_TELEMETRY_TOKEN), read from Google Cloud, so a development
# build or a scripted run sends usage timings. Nothing is printed or written to disk.
#
#   telemetry/with-collector.sh pnpm run dev
#   VEACOM_TELEMETRY_ENVIRONMENT=lab telemetry/with-collector.sh node tools/check-click-budget.cjs ...
set -euo pipefail
source "$(dirname "$0")/gcp/env.sh"
VEACOM_TELEMETRY_ENDPOINT="$(g run services describe otel-collector --region "$REGION" --format='value(status.url)')"
VEACOM_TELEMETRY_TOKEN="$(g secrets versions access latest --secret ingest-token)"
export VEACOM_TELEMETRY_ENDPOINT VEACOM_TELEMETRY_TOKEN
exec "$@"
