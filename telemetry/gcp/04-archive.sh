#!/usr/bin/env bash
# The raw archive: the collector publishes every batch (OTLP protobuf, gzipped) to Pub/Sub,
# and a Cloud Storage subscription writes them to a bucket in London as Avro files, every
# 10 minutes. ClickHouse can be rebuilt from it at any time.
set -euo pipefail
source "$(dirname "$0")/env.sh"
NUMBER=$(g projects describe "$PROJECT" --format="value(projectNumber)")
PUBSUB_AGENT="service-$NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com"

g storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 ||
    g storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access \
        --public-access-prevention
g pubsub topics describe telemetry-raw >/dev/null 2>&1 || g pubsub topics create telemetry-raw
g pubsub topics add-iam-policy-binding telemetry-raw \
    --member="serviceAccount:otel-collector@$PROJECT.iam.gserviceaccount.com" --role=roles/pubsub.publisher >/dev/null
for role in roles/storage.objectCreator roles/storage.legacyBucketReader; do
    g storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$PUBSUB_AGENT" \
        --role="$role" >/dev/null
done
g pubsub subscriptions describe telemetry-raw-archive >/dev/null 2>&1 ||
    g pubsub subscriptions create telemetry-raw-archive --topic=telemetry-raw \
        --cloud-storage-bucket="$BUCKET" --cloud-storage-file-prefix=raw/ \
        --cloud-storage-output-format=avro --cloud-storage-write-metadata --cloud-storage-max-duration=10m
