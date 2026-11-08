# The telemetry backend's Google Cloud project, sourced by every script here.
# Commands name the account and project themselves, so gcloud's own default
# (which may point at another project) is never used or changed.
PROJECT=veacom-platform
ACCOUNT=${GCP_ACCOUNT:-hello@jobclerk.com}  # GCP_ACCOUNT=you@example.com to use your own login
REGION=europe-west2
ZONE=europe-west2-b
# Images are pinned by digest, because a tag can be moved to other content. To upgrade, look up the new tag's
# index digest (docker buildx imagetools inspect IMAGE:TAG) and change the tag comment with it.
CLICKHOUSE_IMAGE=clickhouse/clickhouse-server@sha256:d426d2f612e1e189c90f9a3f8dcd85a03c6851273833817a296bb327e63aa7a7  # 26.8.36.3; 26.8 is a long-term-support line
COLLECTOR_IMAGE=docker.io/otel/opentelemetry-collector-contrib@sha256:340c9ca6a36617084c6661bdc4f0fe92b7cda5a805d61673ec8db375fddc522b  # 0.164.0
BUCKET=veacom-platform-telemetry

g() { gcloud "$@" --project "$PROJECT" --account "$ACCOUNT"; }
