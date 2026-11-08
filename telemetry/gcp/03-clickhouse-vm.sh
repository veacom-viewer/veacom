#!/usr/bin/env bash
# The ClickHouse VM: Container-Optimized OS (patched by Google), no public address, data on
# its own disk that outlives the VM. e2-medium (2 shared vCPUs, 4 GB) is plenty for now;
# resizing is a stop, `set-machine-type`, start.
set -euo pipefail
source "$(dirname "$0")/env.sh"

g compute instances create clickhouse --zone="$ZONE" --machine-type=e2-medium \
    --image-family=cos-stable --image-project=cos-cloud --boot-disk-size=20GB --boot-disk-type=pd-balanced \
    --create-disk=name=clickhouse-data,size=30GB,type=pd-balanced,device-name=clickhouse-data,auto-delete=no \
    --network-interface=subnet=veacom-london,no-address \
    --service-account="clickhouse-vm@$PROJECT.iam.gserviceaccount.com" --scopes=cloud-platform \
    --metadata=clickhouse-image="$CLICKHOUSE_IMAGE",google-logging-enabled=true \
    --metadata-from-file=startup-script="$(dirname "$0")/vm-startup.sh" \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --labels=app=veacom,purpose=telemetry
