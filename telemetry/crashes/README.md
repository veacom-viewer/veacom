# Checking viewer faults

Start `telemetry/tunnel.sh` and leave it running. The check reads the agent credential from `~/.config/veacom/clickhouse-agent`.

```sh
node telemetry/crashes/triage.cjs --hours 24
```

The default query selects field reports. Add `--lab` to check release tests. The window accepts 1 to 744 hours and defaults to 24.

Each output line is a JSON object grouping incidents with the same version, build, OS, process, reason, stage, work, exception, recovery and OS status. A retry retains its incident ID and counts once in that group. The same machine can produce several incidents. Older reports show `unknown` for fields they did not record.

The first and last times are UTC event timestamps. An unclean exit carries the time the next launch detected it. An offline client can upload an older incident after its event time has fallen outside a short query window. Use a longer window when checking an incident after the fact.

The command exits with **0** for an empty result, **1** for matching incidents, and **2** for bad arguments or a failed query. A monitor should treat 2 as an unavailable check. A successful empty query says only that ClickHouse has no matching report in that time window.

Windows may display the same numeric exit code in hexadecimal. To convert a signed decimal code from `os_status`, run `node -p "(-1073741819 >>> 0).toString(16)"`, substituting the reported number. Compare the result with the Application Error event on the affected machine. The exit code alone does not identify the operation that failed.

## Optional Cloud Monitoring notifications

After the durable crash intake is deployed, choose an existing Cloud Monitoring notification channel in the telemetry project and run:

```sh
telemetry/gcp/09-field-fault-alert.sh projects/veacom-platform/notificationChannels/CHANNEL_ID
```

Replace `CHANNEL_ID` with the channel's numeric ID. The script requires the Google Cloud CLI's alpha component and permission to manage alert policies and log-based notification rules. It creates one policy marked `veacom_alert=field_fault`. Rerunning it updates that policy and its destination. No notification policy is installed by the crash service deployment.

The intake emits one constant structured log entry after storage confirms a field report. Its application payload contains only `{"event":"veacom.field_fault_stored"}`. Cloud Run adds its normal resource and timestamp metadata. The policy matches only that marker from the intake service's stdout. It requests at most one notification per hour and closes an idle incident after 24 hours. A retry can generate a second marker for the same fault. Use the triage command for counts.

Logs must reach Cloud Logging for this alert to fire. An offline viewer, an intake or storage failure, or a skipped log entry can leave the alert quiet. Monitor service availability separately. [Cloud Logging alert behavior and quotas](https://docs.cloud.google.com/logging/docs/alerting/log-based-alerts)
