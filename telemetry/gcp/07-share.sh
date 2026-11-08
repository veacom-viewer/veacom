#!/usr/bin/env bash
# Read-only access to the telemetry for one more person's Google account:
#   telemetry/gcp/07-share.sh someone@example.com
# They may open the IAP tunnel to the ClickHouse VM and read the agent's password from
# Secret Manager -- nothing else. Taken back with the same command and --remove.
set -euo pipefail
source "$(dirname "$0")/env.sh"
WHO="user:${1:?which Google account?}"
ACTION=add
[ "${2:-}" = --remove ] && ACTION=remove

g projects "$ACTION-iam-policy-binding" "$PROJECT" --member="$WHO" --role=roles/iap.tunnelResourceAccessor \
    --condition=None >/dev/null
g projects "$ACTION-iam-policy-binding" "$PROJECT" --member="$WHO" --role=roles/compute.viewer \
    --condition=None >/dev/null
g secrets "$ACTION-iam-policy-binding" ch-agent-password --member="$WHO" \
    --role=roles/secretmanager.secretAccessor >/dev/null
echo "${ACTION}ed read-only telemetry access for ${WHO#user:}"
