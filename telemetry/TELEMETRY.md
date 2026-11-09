# Telemetry

Speed and reliability data from VEAcom and the speed kit, kept in ClickHouse for agents to
query with SQL. No images, no patient data, no IP addresses.

```
VEAcom / python -m bench ──OTLP/HTTP + ingest token──▶ collector (Cloud Run, London)
        drops every attribute not listed below, cuts strings at 100 characters
            ├──▶ ClickHouse (VM "clickhouse", no public address)  ◀── agents, read-only, via IAP tunnel
            └──▶ Pub/Sub ──▶ gs://veacom-platform-telemetry/raw/  (raw archive, Avro, every 10 min)
```

Google Cloud project `veacom-platform` (account hello@jobclerk.com), region `europe-west2`.
Budget alert at £80 a month; expected cost is about £30–35 (the VM, its disks, Cloud NAT).

## Automatic crash reports

The installed desktop viewer sends technical fault reports whether usage sharing is granted, denied or unanswered. Usage timings still require consent. The browser viewer does not send these reports.

A report identifies the release, OS, architecture, affected process, failure reason and recovery. The desktop records the startup or shutdown stage; a fatal React render, an unresponsive main window, and uncaught JavaScript errors in the main process or viewer window have distinct reasons. For JavaScript faults the only extra detail is a fixed exception category. For an engine failure the report can include the OS exit code or signal and the broad kind of outstanding work (import, pixels, export, other, multiple or idle). Outstanding work is context for investigation; the engine may have failed for another reason.

If the main process disappears, its next launch under the same profile reports an unclean exit under the previous build and last saved stage. Its timestamp is when the new process detected the exit. A confirmed Windows session end clears the marker. Failure before the reporter starts, a machine that never relaunches, or a frozen main process can still leave no report.

Each incident has a fresh random ID and a fixed HTTPS destination. The client retries with backoff and removes an incident on acknowledgment. A prolonged outage can overflow the 64-event queue; persistence requires a writable profile. No persistent install ID is included. Source builds send only to an explicitly configured endpoint. Lab checks label their reports `lab`.

The client and public intake validate the same closed schema. No report field accepts error messages, stack traces, dumps, URLs, file paths, study or patient identifiers, images, or typed text. The intake builds a new record from the validated fields. The deployment script excludes Cloud Run request logs for the crash services from the project's default log sink. Review other logging sinks and proxies separately when deploying.

In ClickHouse, `ServiceName='veacom-crash'`, `SpanName` identifies the process, `veacom.error_kind` is the reason, `StatusMessage` contains only the signal or numeric exit code, and `veacom.result` is the recovery outcome. Count unique trace IDs because delivery can be retried after a lost acknowledgement. The [field triage command](crashes/README.md) groups faults by release, stage, reason, engine work, exception and recovery without printing raw event bodies.

```sql
SELECT ResourceAttributes['service.version'] AS version, SpanName AS process,
       SpanAttributes['veacom.error_kind'] AS reason, StatusMessage AS os_status,
       SpanAttributes['veacom.result'] AS recovery, uniqExact(TraceId) AS incidents
FROM otel.otel_traces
WHERE ServiceName = 'veacom-crash' AND ResourceAttributes['deployment.environment'] = 'field'
GROUP BY ALL ORDER BY incidents DESC;
```

The CI check forces crashes using an isolated profile, declines usage sharing, and verifies delivery to a local intake. To repeat it against the live backend, set `VEACOM_SMOKE_EXECUTABLE` to the viewer built with `electron-builder.release.cjs` and run `node tools/check-crash-reporting.cjs /tmp/crash-receipt.json --live`. With the read-only tunnel open, run `node telemetry/crashes/verify.cjs /tmp/crash-receipt.json`. It matches each incident ID, reason, OS status, recovery outcome and the complete stored set of attributes. It also checks that the valid usage event submitted during the test is absent from ClickHouse. Run `telemetry/write-endpoint.sh` before packaging to configure the usage collector required by the release build. Windows release jobs also exercise the installed executable with usage declined and retain `installed/crash-receipt.json` in the evidence artifact; verify it against ClickHouse using the same command.

### Deploying crash storage

Upgrade the backend before shipping a viewer that sends new fault fields or reasons. Older intakes reject unfamiliar reports with HTTP 400. Beta.2 and beta.3 discard reports on 400. New viewers keep them for retry, but those reports only become visible after the intake accepts them. On an existing installation, run `telemetry/gcp/08-crashes.sh` first. It deploys the private `veacom-crash-storage` service, grants the crash intake permission to invoke it, and moves the existing public `/v1/crashes` endpoint to that service. Published viewers keep their URL and can send their original report format. The intake acknowledges a report after ClickHouse completes a synchronous insert and Pub/Sub confirms publication to the existing archive. If either export fails, the viewer retries with the same incident ID. Count distinct IDs because one destination may already have accepted the first attempt.

Verify a packaged lab report in ClickHouse, then run `telemetry/gcp/05-collector.sh`. This reserves the `veacom-crash` service name by dropping those spans on the public usage receiver. The installer’s usage token cannot invoke the private service. Keep the public filter in place for subsequent intake rollouts. If an older intake must be restored, restore the previous public collector configuration first.

## Querying it (agents)

1. Open the tunnel and leave it running: `telemetry/tunnel.sh` (localhost:18123).
2. Connect as user `agent`. It is read-only (`readonly = 1`), with a 60 s limit per query,
   200,000 result rows and 2,000 queries an hour. It works through the tunnel only (its
   allowed source is Google's IAP range); something inside the private network, such as a
   Cloud Run job, needs a user of its own. Its
   password is in Secret Manager (`ch-agent-password`), with a copy for this computer in
   `~/.config/veacom/clickhouse-agent`.
3. From Claude Code, through ClickHouse's own MCP server (read-only too):

   ```bash
   claude mcp add --scope user veacom-clickhouse -- sh -c 'CLICKHOUSE_HOST=localhost CLICKHOUSE_PORT=18123 CLICKHOUSE_USER=agent CLICKHOUSE_SECURE=false CLICKHOUSE_PASSWORD="$(cat ~/.config/veacom/clickhouse-agent)" exec uvx mcp-clickhouse'
   ```

   Its tools are `list_databases`, `list_tables` and `run_query`; writes are refused.

   For a plain HTTP query, run `curl --user agent localhost:18123 --data-binary "SELECT 1"` and enter the agent password when curl prompts.

## Giving someone access

`telemetry/gcp/07-share.sh their@account` gives a Google account read-only access: the
tunnel, a view of the VM, and the agent's password in Secret Manager. Nothing else, and no
password is sent to anyone. Add `--remove` to take it back. The address must be a Google
account; any email address can become one at accounts.google.com ("Use your existing email").

They install the Google Cloud CLI and uv, then run `gcloud auth login their@account`.

On a Mac, from the repository:

```bash
GCP_ACCOUNT=their@account telemetry/agent-access.sh
```

```bash
GCP_ACCOUNT=their@account telemetry/tunnel.sh
```

Then they run the `claude mcp add` command above.

On Windows (PowerShell), keep the tunnel running:

```
gcloud compute start-iap-tunnel clickhouse 8123 --local-host-port=localhost:18123 --zone=europe-west2-b --project=veacom-platform --account=their@account
```

Then, in a second window, show the password and add it to Claude Code (which keeps it in its
own settings file):

```
gcloud secrets versions access latest --secret=ch-agent-password --project=veacom-platform --account=their@account
claude mcp add --scope user veacom-clickhouse -e CLICKHOUSE_HOST=localhost -e CLICKHOUSE_PORT=18123 -e CLICKHOUSE_USER=agent -e CLICKHOUSE_SECURE=false -e CLICKHOUSE_PASSWORD=PASTE_IT_HERE -- uvx mcp-clickhouse
```

## Tables

The OpenTelemetry Collector's standard ClickHouse layout, in database `otel`:

| table | holds |
|---|---|
| `otel_traces` | one row per span: `Timestamp`, `TraceId`, `SpanId`, `ParentSpanId`, `SpanName`, `Duration` (ns), `ServiceName`, `ResourceAttributes` and `SpanAttributes` (maps), `Events.*` |
| `otel_traces_trace_id_ts` | first and last time of each trace (fast lookup by `TraceId`) |
| `otel_metrics_histogram`, `_sum`, `_gauge`, `_summary`, `_exponential_histogram` | metrics by kind; `MetricName`, `Attributes`, `ResourceAttributes` |

Rows are kept forever (no TTL); the raw archive holds everything as well.

## What may be sent

Only these attributes survive the collector; anything else is dropped there. Text from DICOM
headers and file paths must never be sent, even under an allowed name: patient names hide
in series descriptions and folder names.

Resource (who and on what):

- `service.name` (`veacom` or `veacom-bench`), `service.version`, `veacom.commit`;
- `deployment.environment`: `field` (users) or `lab` (the speed kit);
- `os.type`, `os.version`, `host.arch`, `telemetry.sdk.*`;
- `veacom.install_id`: random, resettable by the user;
- `veacom.machine.label` (lab machines only);
- `veacom.machine.{cpu, cores, ram_gb, gpu, gpu_driver, renderer, software_renderer, screen, screen_hz, device_pixel_ratio, power}`.

Span (what happened):

- `veacom.study.{name, modality, series, slices, matrix, mb, syntax, source}`, where `name`
  is lab studies only and `source` is `disk`, `cd`, `network` or `zip`;
- `veacom.{scenario, trigger, window, layout, run, valid, result, error_kind, frames, value_ms, slice, colour_window}`.

Span events: `veacom.slice`, `veacom.colour_window`, `veacom.value_ms`.

Usage timings (span names `ux.*`, see below): `veacom.{action, input, seq, t_ms, changed, hover_ms,
steps, surface, plane, tool, modality, wl, zoom, series_index, slice_pct, session}`, with
`veacom.{layout, window, result, trigger}` and `veacom.study.{modality, series, slices, source}`
from the lists above. Every value is checked against `electron/usage-schema.json` in the app before
it is stored or sent.

Metric data points: `veacom.study.{name, modality, slices, syntax, source}` and
`veacom.{scenario, window, layout, valid}`.

To allow a new attribute, add it to `collector/config.yaml` and run `gcp/05-collector.sh`.

## Example queries

```sql
-- Everything sent in the last day, by service and environment
SELECT ServiceName, ResourceAttributes['deployment.environment'] AS env, count()
FROM otel.otel_traces WHERE Timestamp > now() - INTERVAL 1 DAY GROUP BY ALL;

-- Slowest operations by span name, 75th and 95th percentile
SELECT SpanName, quantiles(0.75, 0.95)(Duration / 1e6) AS ms, count()
FROM otel.otel_traces GROUP BY SpanName ORDER BY ms[2] DESC LIMIT 20;

-- The same, split by graphics card
SELECT ResourceAttributes['veacom.machine.gpu'] AS gpu, quantile(0.75)(Duration / 1e6) AS p75_ms, count()
FROM otel.otel_traces WHERE SpanName = 'study.open' GROUP BY gpu ORDER BY p75_ms DESC;
```

## Building and changing it

Scripts in order, each safe to read before running: `gcp/01-network.sh`,
`02-secrets.sh`, `03-clickhouse-vm.sh` (with `vm-startup.sh`), `clickhouse/users.sh`
(through the tunnel), `gcp/04-archive.sh`, `05-collector.sh`, `06-no-ip-logs.sh`. The
first collector start ran with `CREATE_SCHEMA=true` and `SCHEMA=create` so it could make
its tables; both are back to their locked defaults.

The usage-timing views are in `clickhouse/ux-views.sql`; `clickhouse/views.sh` (re)creates them
through the tunnel as admin.

Not done yet:

- The speed kit doesn't send anything yet; VEAcom 2 sends usage timings (below).
- The views for speed questions (`viewer_vitals_daily`, `opens`, `slow_moments`) come with them.
- No nightly ClickHouse backup: the raw archive is the copy for now.

## Usage timings (VEAcom 2)

How long, and how many actions, any task takes, from real use. The app records one span per user
action (`ux.action`): a click, a shortcut, a drag from press to release, a wheel or key-repeat burst,
a drop. Each carries a stable action id (the control's `data-testid` or `data-action`, never its text),
the input kind (`mouse`, `key`, `wheel`, `drag`, `drop`, `touch`), a monotonic time (`t_ms` since the
study started opening, and the span's own timestamp) and the coarse state after it: modality, plane,
layout, active tool, window class (`stored`, `lung`, `manual`...), W/L, zoom, filmstrip position of
the series and the slice as a percentage. `changed` lists which parts of the state the action changed
(`series,window`...); an action that changed nothing has none. Changes nobody asked for (a series
finishing loading) are `ux.state` events with input `auto`, so each change belongs to exactly one event.

Study events: `ux.study.open` (how it was opened, `trigger`; where from, `source`: disk, cd, zip or
network; the modality mix, image-series count and a slice-count bucket; its duration is the import),
`ux.study.first_image` (its `t_ms` is the time from opening to the first image) and `ux.study.close`.
Each opened study gets a random id, the span's `TraceId`; events before any study carry the launch's
own id. `ux.milestone` marks what the app finished: `series-loaded`, `view3d-ready`,
`export-video-done` (and the other exports), with `result` ok, cancel or error.

Never sent: names, IDs, UIDs, dates, file paths, DICOM header text, anything typed, or pixels. The
renderer builds events only from closed vocabularies and numbers; the main process checks every event
against `electron/usage-schema.json` again (unknown attributes and values are dropped); the collector's
allowlist is the third guard. `tests/usage-schema.test.ts` checks that the allowlist lets the schema
through and that the schema holds no free text.

Resource: `service.name` = `veacom`, `deployment.environment` = `field` (packaged), `dev`
(development builds) or `lab` (scripted runs and release checks, `VEACOM_TELEMETRY_ENVIRONMENT=lab`;
in development builds these also name the study and scenario, `veacom.study.name`, `veacom.scenario`), the version, OS, architecture,
the install id, and how images are drawn (`veacom.machine.renderer`, `veacom.machine.software_renderer`):
software drawing changes every duration.

**Consent.** Nothing is recorded until the user agrees: a fresh install asks once, in a strip under
the toolbar (Turkish or English, never a modal). The inspector's display panel has the off switch;
turning it off deletes the local copy and the install id (turning it on again starts a new one).
Answers are saved in the profile's `preferences.json`.

**Local copy.** Agreed events are kept in the profile folder (`%APPDATA%/VEAcom/usage` on Windows,
`~/Library/Application Support/VEAcom/usage` on a Mac) as JSON lines, at most 8 MiB (the oldest go
first), and sent from there, so a hospital whose network blocks the collector still has them; a
cursor file records what the collector has received.

**Sending.** OTLP/HTTP JSON to the collector with the ingest token, every 20 s and at quit, from the
main process (the window cannot reach the network). Development accepts `VEACOM_TELEMETRY_ENDPOINT` and `VEACOM_TELEMETRY_TOKEN`. A packaged build ignores consent and endpoint overrides and takes only the `lab` label from the environment, so release checks do not count as real use; it uses only the department collector address and write-only token from `electron/telemetry-endpoint.json`: run `telemetry/write-endpoint.sh` before packaging (the file is git-ignored).
Without either, events stay local. For a development build:

```bash
telemetry/with-collector.sh pnpm run dev
```

### Questions as SQL

Defined afterwards, so a new question needs a query, not a build (`clickhouse/ux-views.sql`):

| view | answers |
|---|---|
| `ux_events` | every usage event, typed (`study_id`, `seq`, `t_ms`, `end_ms`, `action`, `input`, `changed`, state) |
| `ux_studies` | one row per opened study: trigger, source, modality mix, import and first-image times |
| `ux_kept_view_p(hold_ms, facets, measure, after_load)` | time and actions from opening to the first kept view, with the definition as parameters |
| `ux_first_kept_view` | the default: unchanged series, plane, window, zoom, layout and screen for 3 s (scrolling allowed), or a measurement started |
| `ux_first_kept_view_after_load` | the same, but a view held while its series was still loading only counts from when it loaded |
| `ux_kept_view_by_modality` | the north-star number by modality, both definitions |
| `ux_task_p(starts, ends, end_result, end_changed, end_states)` | episodes of any task: duration, actions, the path taken |
| `ux_tasks`, `ux_tasks_summary` | length measurement, MPR, 3D, video export and window changes |
| `ux_window_runs` | window changes made in a row: how many until the window is left alone |
| `ux_friction_undo`, `ux_friction_toggle`, `ux_friction_noop`, `ux_toolbar_hover`, `ux_friction` | undo right after an action, on-and-off within 2 s, actions that changed nothing, hover time on the toolbar before a click, and all of them per action |
| `ux_perf` | CPU and memory peaks, one row per process role per minute |
| `ux_lab_installs` | installs that report `field` but are not real use; `ux_events` and `ux_perf` report them as `lab` |

```sql
-- Time and actions to the first kept view, by modality, field use only
SELECT * FROM otel.ux_kept_view_by_modality WHERE environment = 'field';

-- Make scrolling end a view, and wait for loading
SELECT modality, quantile(0.5)(kept_ms), quantile(0.5)(kept_actions), count()
FROM otel.ux_kept_view_p(hold_ms = 3000, facets = ['series','plane','window','zoom','layout','screen','slice'], measure = 1, after_load = 1)
WHERE environment = 'field' GROUP BY modality;

-- A new task without a build: measuring an angle
SELECT quantile(0.5)(duration_ms), quantile(0.5)(actions), topK(3)(arrayStringConcat(path, ' → '))
FROM otel.ux_task_p(starts = ['measure-angle', 'tool-measure', 'tool-measure-menu'], ends = ['point-angle'], end_result = 'ok', end_changed = [], end_states = []);

-- Which controls are hunted for longest on the toolbar
SELECT * FROM otel.ux_toolbar_hover WHERE environment = 'field' AND clicks >= 20 LIMIT 20;
```

### Click budgets and the lab baseline

The desktop checks drive canonical tasks with real input and count their actions with the same
events (`tools/click-budget.cjs`); `tools/click-budgets.json` holds today's counts, and a longer path
fails the check like a performance budget, as does a step that changes nothing. `tools/desktop-smoke.cjs` budgets its steps;
`tools/check-click-budget.cjs` runs the canonical tasks, including a scripted "wanted view" on the fingerprinted synthetic CT
study. `tools/verify.sh` runs both, and `tools/check-budget-coverage.cjs` fails if a budget was not measured. A lab baseline in ClickHouse:

```bash
VEACOM_TELEMETRY_ENVIRONMENT=lab VEACOM_TELEMETRY_SCENARIO=baseline-v2 telemetry/with-collector.sh node tools/check-click-budget.cjs ~/veacom-bench/studies/ct-small
```

On macOS the checks' windows ignore physical mouse and keyboard input; elsewhere, using the computer
while they run is counted and fails the budget.

### CPU and memory spikes

With sharing on, VEAcom samples its Electron main, renderer, GPU and helper processes and its separately launched Rust engine. It samples about once a second with the window visible and every five seconds otherwise. It never enumerates other applications. A closed profile emits the final partial window; a crash can lose that window.

One `perf.resources` span per role per minute records maximum interval CPU, peak sampled resident MiB, rise from a recent low and the highest individual process lifetime resident peak where available. CPU percentages count cores: 100% is one busy core. A CPU flag requires readings at or above 90% for at least two seconds. A RAM flag needs a 256 MiB rise, including an increase in a process's lifetime high-water mark between polls. These are starting thresholds, not errors. A large stable study is not a leak. RSS includes shared pages, so do not add roles and call that unique RAM. GPU-process CPU is not GPU utilization or VRAM. Subsecond CPU stalls can be averaged out. After a restart, suspend or missing sample, do not infer a zero value.

Use the nearest reported tool and the peak time to investigate; they do not establish cause. Look for regressions by OS and app version, using the baseline rows as the denominator. The following reads only numeric/enum aggregates:

```sql
SELECT version, os, role, count() AS windows,
       countIf(signal IN ('cpu','cpu-ram')) AS cpu_windows,
       countIf(signal IN ('ram','cpu-ram')) AS ram_windows,
       quantile(0.95)(ram_mib) AS p95_peak_mib
FROM otel.ux_perf
WHERE ts > now() - INTERVAL 7 DAY AND environment = 'field'
GROUP BY version, os, role ORDER BY version, os, role;
```
