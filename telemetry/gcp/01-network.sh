#!/usr/bin/env bash
# A private network for the telemetry backend: one subnet in London and no way in from the
# internet. SSH and ClickHouse's HTTP port are reached only through Google's IAP tunnel;
# the collector reaches ClickHouse from inside the subnet. Cloud NAT lets the VM pull its
# image without a public address of its own.
set -euo pipefail
source "$(dirname "$0")/env.sh"

g compute networks create veacom-net --subnet-mode=custom
g compute networks subnets create veacom-london --network=veacom-net --region="$REGION" \
    --range=10.10.0.0/24 --enable-private-ip-google-access
g compute firewall-rules create veacom-allow-iap --network=veacom-net --direction=INGRESS \
    --source-ranges=35.235.240.0/20 --allow=tcp:22,tcp:8123
g compute firewall-rules create veacom-allow-internal --network=veacom-net --direction=INGRESS \
    --source-ranges=10.10.0.0/24 --allow=tcp:8123,tcp:9000
g compute routers create veacom-router --network=veacom-net --region="$REGION"
g compute routers nats create veacom-nat --router=veacom-router --region="$REGION" \
    --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges

# The network Compute Engine makes by default has SSH and RDP open to the world: not used.
for rule in $(g compute firewall-rules list --filter="network:default" --format="value(name)"); do
    g compute firewall-rules delete "$rule" --quiet
done
g compute networks delete default --quiet || true
