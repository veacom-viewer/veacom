#!/usr/bin/env bash
# Writes electron/telemetry-endpoint.json (git-ignored): the collector's address and the ingest
# token, packaged into a build (electron/** is in the package) so field copies can send usage
# timings once a user agrees. Run it before packaging a department build; never commit the file.
# Nothing is printed. Without the file a build keeps its usage timings on the computer only.
set -euo pipefail
source "$(dirname "$0")/gcp/env.sh"
FILE="$(cd "$(dirname "$0")/.." && pwd)/electron/telemetry-endpoint.json"
URL="$(g run services describe otel-collector --region "$REGION" --format='value(status.url)')"
TOKEN="$(g secrets versions access latest --secret ingest-token)"
umask 077
[[ "$URL" == "https://otel-collector-5phqzw3wxq-nw.a.run.app" ]] || { echo "Unexpected collector address." >&2; exit 1; }
TOKEN="$TOKEN" node -e 'const fs=require("fs"), f=process.argv[1]+".tmp"; try { fs.writeFileSync(f, JSON.stringify({endpoint: process.argv[2],token: process.env.TOKEN}), {mode:0o600,flag:"wx"}); fs.renameSync(f,process.argv[1]); } finally { fs.rmSync(f,{force:true}); }' "$FILE" "$URL"
echo "wrote electron/telemetry-endpoint.json"
