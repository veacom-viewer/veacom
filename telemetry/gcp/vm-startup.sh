#!/bin/bash
# The ClickHouse VM's startup script (Container-Optimized OS), run at every boot: mounts the
# data disk (formatting it the first time only) and starts ClickHouse with the admin
# password from Secret Manager. Image tag: the VM's "clickhouse-image" metadata.
set -euo pipefail
DISK=/dev/disk/by-id/google-clickhouse-data
MOUNT=/mnt/disks/clickhouse
blkid "$DISK" >/dev/null 2>&1 || mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard -F "$DISK"
mkdir -p "$MOUNT"
mountpoint -q "$MOUNT" || mount -o discard,defaults "$DISK" "$MOUNT"
mkdir -p "$MOUNT/data" "$MOUNT/logs"
# Container-Optimized OS lets in only SSH by default: open ClickHouse's ports (the
# project's firewall rules decide who may reach them). Not kept across reboots: hence here.
for port in 8123 9000; do
    iptables -w -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || iptables -w -A INPUT -p tcp --dport "$port" -j ACCEPT
done

META=http://metadata.google.internal/computeMetadata/v1
meta() { curl -sf -H "Metadata-Flavor: Google" "$META/$1"; }
IMAGE=$(meta instance/attributes/clickhouse-image)
PROJECT=$(meta project/project-id)
TOKEN=$(meta instance/service-accounts/default/token | sed -E 's/.*"access_token":"([^"]+)".*/\1/')
PASSWORD=$(curl -sf -H "Authorization: Bearer $TOKEN" \
    "https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/ch-admin-password/versions/latest:access" |
    tr -d '\n ' | sed -E 's/.*"data":"([^"]+)".*/\1/' | base64 -d)

docker rm -f clickhouse >/dev/null 2>&1 || true
docker run -d --name clickhouse --restart always --network host --ulimit nofile=262144:262144 \
    -v "$MOUNT/data:/var/lib/clickhouse" -v "$MOUNT/logs:/var/log/clickhouse-server" \
    -e CLICKHOUSE_USER=admin -e CLICKHOUSE_PASSWORD="$PASSWORD" -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
    "$IMAGE"
