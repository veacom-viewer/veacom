-- Usage timings as SQL (VEAcom 2, src/usage): every user action and study event, and questions defined
-- on top of them, so a new question needs a new query, not a new build. Applied by
-- telemetry/clickhouse/views.sh (admin, through the tunnel); agents read them as `agent`.
-- Statements end with a line holding only ';'.
--
-- Times: t_ms is milliseconds since the study started opening (the import, or the window's creation
-- for a study given at launch). study_id is the random id of one opened study; events before any
-- study carry their launch's own id. environment: field (real use), dev (development builds), lab
-- (scripted runs and release checks; development builds also name the study and scenario).

-- Installs that report field but are not real use: release checks on 0.1.0-beta.1 packages, which could not
-- label themselves lab. Later checks send VEACOM_TELEMETRY_ENVIRONMENT=lab, so this list should not grow.
-- Matched by the start of the random install id.
CREATE OR REPLACE VIEW otel.ux_lab_installs AS
SELECT arrayJoin(['dd27101d4c88', '666ec54ff3b0']) AS install_prefix
;

-- Every usage event, typed.
CREATE OR REPLACE VIEW otel.ux_events AS
SELECT
    TraceId AS study_id,
    Timestamp AS ts,
    Duration / 1e6 AS duration_ms,
    CAST(SpanName, 'String') AS event,
    CAST(SpanName, 'String') = 'ux.action' AS is_action,
    SpanAttributes['veacom.action'] AS action,
    SpanAttributes['veacom.input'] AS input,
    toUInt64OrZero(SpanAttributes['veacom.seq']) AS seq,
    toInt64OrZero(SpanAttributes['veacom.t_ms']) AS t_ms,
    -- When an action ended (a drag released, a scroll burst over); other events are instants.
    t_ms + if(CAST(SpanName, 'String') = 'ux.action', toInt64(round(Duration / 1e6)), 0) AS end_ms,
    if(SpanAttributes['veacom.changed'] = '', CAST([], 'Array(String)'), splitByChar(',', SpanAttributes['veacom.changed'])) AS changed,
    -- An action that changed nothing. 0.1.0-beta.1 could not see what these do, so they do not count there: asking
    -- for the native open dialog, the unfinished points and notes of a measurement, selecting one, a surface
    -- export starting, and a link opening in the browser.
    CAST(SpanName, 'String') = 'ux.action' AND SpanAttributes['veacom.changed'] = ''
        AND NOT (ResourceAttributes['service.version'] = '0.1.0-beta.1'
            AND match(SpanAttributes['veacom.action'], '^(welcome-open-(files|folder|archive)|open-folder|click-(length|rectangle|ellipse|arrow)|point-(angle|cobb|polygon|polyline|text)|annotation-(select|text-input|text-add|text-cancel)|volume-export-stl|assessment-(source|radiopaedia)-link)$')) AS noop,
    SpanAttributes['veacom.result'] AS result,
    toUInt32OrNull(SpanAttributes['veacom.hover_ms']) AS hover_ms,
    toUInt32OrZero(SpanAttributes['veacom.steps']) AS steps,
    SpanAttributes['veacom.surface'] AS surface,
    SpanAttributes['veacom.layout'] AS layout,
    SpanAttributes['veacom.plane'] AS plane,
    SpanAttributes['veacom.tool'] AS tool,
    SpanAttributes['veacom.modality'] AS modality,
    SpanAttributes['veacom.window'] AS window_class,
    SpanAttributes['veacom.wl'] AS wl,
    toFloat64OrNull(SpanAttributes['veacom.zoom']) AS zoom,
    toUInt32OrZero(SpanAttributes['veacom.series_index']) AS series_index,
    toInt32OrNull(SpanAttributes['veacom.slice_pct']) AS slice_pct,
    SpanAttributes['veacom.trigger'] AS trigger,
    SpanAttributes['veacom.session'] AS session,
    SpanAttributes['veacom.study.modality'] AS study_modalities,
    toUInt32OrZero(SpanAttributes['veacom.study.series']) AS study_series,
    SpanAttributes['veacom.study.slices'] AS study_slices,
    SpanAttributes['veacom.study.source'] AS study_source,
    SpanAttributes['veacom.study.name'] AS study_name,
    SpanAttributes['veacom.scenario'] AS scenario,
    if(arrayExists(prefix -> startsWith(ResourceAttributes['veacom.install_id'], prefix), (SELECT groupArray(install_prefix) FROM otel.ux_lab_installs)),
        'lab', ResourceAttributes['deployment.environment']) AS environment,
    ResourceAttributes['service.version'] AS version,
    ResourceAttributes['veacom.install_id'] AS install_id,
    ResourceAttributes['os.type'] AS os,
    ResourceAttributes['veacom.machine.software_renderer'] = 'true' AS software_renderer
FROM otel.otel_traces
WHERE ServiceName = 'veacom' AND startsWith(SpanName, 'ux.')
;

-- One row per opened study: how it was opened and what kind of study, never what it contains.
CREATE OR REPLACE VIEW otel.ux_studies AS
SELECT
    study_id,
    minIf(ts, event = 'ux.study.open') AS opened_at,
    any(environment) AS environment,
    any(version) AS version,
    any(install_id) AS install_id,
    any(os) AS os,
    max(software_renderer) AS software_renderer,
    anyIf(trigger, event = 'ux.study.open') AS trigger,
    anyIf(result, event = 'ux.study.open') AS open_result,
    anyIf(study_modalities, event = 'ux.study.open') AS modalities,
    anyIf(study_series, event = 'ux.study.open') AS image_series,
    anyIf(study_slices, event = 'ux.study.open') AS slices,
    anyIf(study_source, event = 'ux.study.open') AS source,
    anyIf(study_name, event = 'ux.study.open') AS study_name,
    anyIf(scenario, event = 'ux.study.open') AS scenario,
    anyIf(session, event = 'ux.study.open') AS session,
    round(anyIf(duration_ms, event = 'ux.study.open')) AS import_ms,
    minIfOrNull(t_ms, event = 'ux.study.first_image') AS first_image_ms,
    anyIf(modality, event = 'ux.study.first_image') AS first_modality,
    anyIf(plane, event = 'ux.study.first_image') AS first_plane,
    anyIf(window_class, event = 'ux.study.first_image') AS first_window,
    countIf(is_action) AS actions,
    max(t_ms) AS last_event_ms,
    maxIfOrNull(t_ms, event = 'ux.study.close') AS closed_ms,
    anyIf(result, event = 'ux.study.close') AS close_reason
FROM otel.ux_events
GROUP BY study_id
HAVING countIf(event = 'ux.study.open') > 0
;

-- Time and actions from opening a study to the first view the user keeps, with the definition as
-- parameters:
--   hold_ms  how long the view must stay unchanged (default 3000);
--   facets   which changes end a view (default series, plane, window, zoom, layout, screen; add
--            'slice' to make scrolling end a view too, 'pan' for panning);
--   measure     1: a measurement started on a view keeps it at once;
--   after_load  1: a view shown while its series was still loading starts its hold only when the
--               series finished loading (waiting is not keeping); 0: the hold starts when it appears.
-- A view starts with the first image or with any event (action, or the app's own change) that changed
-- one of the facets, when that event ended. kept_actions counts every action up to and including the
-- one that reached the kept view; kept_ms is when that view appeared. Studies without one have NULLs.
--   SELECT * FROM otel.ux_kept_view_p(hold_ms = 3000, facets = ['series','plane','window','zoom','layout','screen'], measure = 1, after_load = 1)
CREATE OR REPLACE VIEW otel.ux_kept_view_p AS
WITH
    first_images AS (
        SELECT study_id, min(seq) AS first_seq FROM otel.ux_events WHERE event = 'ux.study.first_image' GROUP BY study_id
    ),
    loads AS (
        SELECT study_id, series_index, min(t_ms) AS loaded_ms FROM otel.ux_events
        WHERE event = 'ux.milestone' AND action = 'series-loaded' GROUP BY study_id, series_index
    ),
    tagged AS (
        SELECT e.study_id AS study_id, e.seq AS seq, e.t_ms AS t_ms, e.end_ms AS end_at, e.is_action AS is_action, e.event AS event, e.action AS action,
            e.is_action AND (startsWith(e.action, 'draw-') OR startsWith(e.action, 'point-') OR (match(e.action, '^click-(length|rectangle|ellipse|arrow)$') AND NOT has(e.changed, 'panel'))) AS is_measure,
            e.seq >= f.first_seq AS shown,
            e.seq = f.first_seq OR (e.seq > f.first_seq AND hasAny(e.changed, {facets:Array(String)})) AS is_view,
            e.modality AS modality, e.plane AS plane, e.window_class AS window_class, e.layout AS layout, e.surface AS surface,
            e.series_index AS series_index, e.slice_pct AS slice_pct
        FROM otel.ux_events AS e INNER JOIN first_images AS f ON e.study_id = f.study_id
    ),
    numbered AS (
        SELECT *,
            sum(is_action) OVER (PARTITION BY study_id ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS actions_so_far,
            max(t_ms) OVER (PARTITION BY study_id) AS end_ms,
            max(if(is_view, seq, 0)) OVER (PARTITION BY study_id ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS segment
        FROM tagged
    ),
    segments AS (
        SELECT study_id, segment,
            anyIf(end_at, seq = segment) AS view_ms,
            anyIf(t_ms, seq = segment) AS start_ms,
            anyIf(actions_so_far, seq = segment) AS actions,
            anyIf(if(is_action, action, event), seq = segment) AS reached_by,
            countIf(is_measure) > 0 AS measured,
            any(end_ms) AS end_ms,
            anyIf(modality, seq = segment) AS modality,
            anyIf(plane, seq = segment) AS plane,
            anyIf(window_class, seq = segment) AS window_class,
            anyIf(layout, seq = segment) AS layout,
            anyIf(surface, seq = segment) AS surface,
            anyIf(series_index, seq = segment) AS series_index,
            anyIf(slice_pct, seq = segment) AS slice_pct
        FROM numbered
        WHERE shown AND segment > 0
        GROUP BY study_id, segment
    ),
    followed AS (
        SELECT *,
            -- The next view begins when its event begins (a drag that changes the window ends this one).
            coalesce(leadInFrame(toNullable(start_ms)) OVER (PARTITION BY study_id ORDER BY segment ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING), end_ms) AS until_ms
        FROM segments
    ),
    judged AS (
        SELECT f.*,
            until_ms - if({after_load:UInt8} = 1 AND l.loaded_ms > f.view_ms, l.loaded_ms, f.view_ms) AS held_ms
        FROM followed AS f LEFT JOIN loads AS l ON f.study_id = l.study_id AND f.series_index = l.series_index
    ),
    kept AS (
        SELECT study_id,
            argMin(view_ms, segment) AS view_ms,
            argMin(actions, segment) AS actions,
            argMin(if(held_ms >= {hold_ms:UInt32}, 'hold', 'measurement'), segment) AS kept_by,
            argMin(reached_by, segment) AS reached_by,
            argMin(modality, segment) AS modality,
            argMin(plane, segment) AS plane,
            argMin(window_class, segment) AS window_class,
            argMin(layout, segment) AS layout,
            argMin(surface, segment) AS surface,
            argMin(series_index, segment) AS series_index,
            argMin(slice_pct, segment) AS slice_pct,
            countIf(segment > 0) AS candidate_views
        FROM judged
        WHERE held_ms >= {hold_ms:UInt32} OR (measured AND {measure:UInt8} = 1)
        GROUP BY study_id
    )
SELECT
    s.study_id AS study_id, s.opened_at AS opened_at, s.environment AS environment, s.version AS version, s.os AS os,
    s.software_renderer AS software_renderer, s.trigger AS trigger, s.source AS source, s.modalities AS modalities,
    s.first_modality AS modality, s.image_series AS image_series, s.slices AS slices, s.study_name AS study_name, s.scenario AS scenario,
    s.first_image_ms AS first_image_ms, s.first_window AS first_window,
    k.study_id != '' AS kept,
    if(k.study_id = '', NULL, k.view_ms) AS kept_ms,
    if(k.study_id = '', NULL, k.actions) AS kept_actions,
    if(k.study_id = '', NULL, k.kept_by) AS kept_by,
    if(k.study_id = '', NULL, k.reached_by) AS reached_by,
    if(k.study_id = '', NULL, k.series_index) AS kept_series_index,
    if(k.study_id = '', NULL, k.plane) AS kept_plane,
    if(k.study_id = '', NULL, k.window_class) AS kept_window,
    if(k.study_id = '', NULL, k.layout) AS kept_layout,
    if(k.study_id = '', NULL, k.surface) AS kept_screen,
    if(k.study_id = '', NULL, k.slice_pct) AS kept_slice_pct,
    s.actions AS study_actions
FROM otel.ux_studies AS s
LEFT JOIN kept AS k ON s.study_id = k.study_id
;

-- The default definition: 3 s unchanged (scrolling allowed), or a measurement started.
CREATE OR REPLACE VIEW otel.ux_first_kept_view AS
SELECT * FROM otel.ux_kept_view_p(hold_ms = 3000, facets = ['series', 'plane', 'window', 'zoom', 'layout', 'screen'], measure = 1, after_load = 0)
;

-- The same, with a view held while its series was still loading starting its 3 s only once loaded.
CREATE OR REPLACE VIEW otel.ux_first_kept_view_after_load AS
SELECT * FROM otel.ux_kept_view_p(hold_ms = 3000, facets = ['series', 'plane', 'window', 'zoom', 'layout', 'screen'], measure = 1, after_load = 1)
;

-- The north-star number by modality (of the first image shown), for both definitions.
CREATE OR REPLACE VIEW otel.ux_kept_view_by_modality AS
SELECT
    definition,
    environment,
    modality,
    count() AS studies,
    countIf(kept) AS kept_studies,
    round(quantileExactIf(0.5)(kept_ms, kept)) AS median_ms,
    round(quantileExactIf(0.9)(kept_ms, kept)) AS p90_ms,
    quantileExactIf(0.5)(kept_actions, kept) AS median_actions,
    round(avgIf(kept_actions, kept), 2) AS mean_actions,
    round(countIf(kept AND kept_actions = 0) / greatest(countIf(kept), 1), 3) AS first_image_kept_share
FROM (
    SELECT 'default' AS definition, * FROM otel.ux_first_kept_view
    UNION ALL
    SELECT 'after-load' AS definition, * FROM otel.ux_first_kept_view_after_load
)
GROUP BY definition, environment, modality
ORDER BY definition, environment, modality
;

-- Task episodes for any task, defined by parameters:
--   starts        actions that begin the task (its entry points: a toolbar button, a shortcut);
--   ends          actions or milestones that complete it (empty: any action matching the rest);
--   end_result    required result of an ending action ('ok' for a finished measurement; '' for any);
--   end_changed   the ending action must change one of these (empty: no condition);
--   end_states    the state after it must include one of these (layout, plane, window class or
--                 screen; empty: no condition).
-- An episode ends at each completion; it starts at the first entry point after the previous
-- completion (or at the completion itself, when the task was one action). actions counts every action
-- in between, detours included; path lists them.
--   SELECT * FROM otel.ux_task_p(starts = ['measure-angle'], ends = ['point-angle'], end_result = 'ok', end_changed = [], end_states = [])
CREATE OR REPLACE VIEW otel.ux_task_p AS
WITH
    tagged AS (
        SELECT study_id, seq, t_ms, end_ms, is_action, action, environment, modality,
            is_action AND has({starts:Array(String)}, action) AS is_start,
            (is_action AND (empty({ends:Array(String)}) OR has({ends:Array(String)}, action))
                AND ({end_result:String} = '' OR result = {end_result:String})
                AND (empty({end_changed:Array(String)}) OR hasAny(changed, {end_changed:Array(String)}))
                AND (empty({end_states:Array(String)}) OR hasAny([layout, plane, window_class, surface], {end_states:Array(String)})))
            OR (event = 'ux.milestone' AND has({ends:Array(String)}, action) AND result = 'ok') AS is_end
        FROM otel.ux_events
        WHERE event IN ('ux.action', 'ux.milestone')
    ),
    numbered AS (
        SELECT *, sum(is_end) OVER (PARTITION BY study_id ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS episode
        FROM tagged
    ),
    episodes AS (
        SELECT study_id, episode, any(environment) AS environment,
            arraySort(row -> row.1, groupArray((seq, t_ms, is_action, is_start, is_end, action, modality, end_ms))) AS rows,
            arrayFirstIndex(row -> row.5, rows) AS end_index,
            arrayFirstIndex(row -> row.4, rows) AS first_start
        FROM numbered
        GROUP BY study_id, episode
        HAVING end_index > 0
    )
SELECT
    study_id,
    environment,
    episode + 1 AS episode,
    rows[end_index].7 AS modality,
    if(first_start > 0 AND first_start <= end_index, first_start, end_index) AS start_index,
    rows[start_index].2 AS start_ms,
    rows[end_index].8 AS end_ms,
    end_ms - start_ms AS duration_ms,
    arrayMap(row -> row.6, arrayFilter(row -> row.3, arraySlice(rows, start_index, end_index - start_index + 1))) AS path,
    length(path) AS actions
FROM episodes
;

-- The standard tasks: a length measurement, reaching MPR, opening 3D, exporting a video, and
-- changing the window (each change; ux_window_runs groups changes made in a row).
CREATE OR REPLACE VIEW otel.ux_tasks AS
SELECT 'length' AS task, * FROM otel.ux_task_p(starts = ['tool-length', 'measure-length', 'tool-measure', 'tool-measure-menu', 'click-length'], ends = ['draw-length', 'click-length'], end_result = 'ok', end_changed = [], end_states = [])
UNION ALL
SELECT 'mpr' AS task, * FROM otel.ux_task_p(starts = ['tool-mpr', 'tool-mpr-menu', 'tool-oblique', 'plane-axial', 'plane-coronal', 'plane-sagittal', 'mpr-three'],
    ends = ['tool-mpr', 'mpr-three', 'plane-axial', 'plane-coronal', 'plane-sagittal', 'oblique-pitch', 'oblique-yaw'], end_result = '', end_changed = ['layout', 'plane'], end_states = ['mpr', 'coronal', 'sagittal', 'oblique'])
UNION ALL
SELECT '3d' AS task, * FROM otel.ux_task_p(starts = ['tool-3d'], ends = ['view3d-ready'], end_result = '', end_changed = [], end_states = [])
UNION ALL
SELECT 'video-export' AS task, * FROM otel.ux_task_p(starts = ['tool-export', 'export-video'], ends = ['export-video-done'], end_result = '', end_changed = [], end_states = [])
UNION ALL
SELECT 'window' AS task, * FROM otel.ux_task_p(starts = ['tool-window', 'tool-window-presets', 'tool-quick-window', 'display-settings', 'window-width-input', 'window-level-input'],
    ends = ['preset-auto', 'preset-dicom', 'preset-soft-tissue', 'preset-lung', 'preset-bone', 'preset-brain', 'preset-liver', 'preset-angiography',
        'drag-window', 'window-width-input', 'window-level-input'], end_result = '', end_changed = ['window'], end_states = [])
;

CREATE OR REPLACE VIEW otel.ux_tasks_summary AS
SELECT environment, task, count() AS episodes,
    round(quantileExact(0.5)(duration_ms)) AS median_ms, round(quantileExact(0.9)(duration_ms)) AS p90_ms,
    quantileExact(0.5)(actions) AS median_actions, round(avg(actions), 2) AS mean_actions, max(actions) AS max_actions,
    topK(3)(arrayStringConcat(path, ' → ')) AS common_paths
FROM otel.ux_tasks
GROUP BY environment, task
ORDER BY environment, task
;

-- Window changes made in a row (less than 3 s apart): how many changes until the window is left alone.
CREATE OR REPLACE VIEW otel.ux_window_runs AS
WITH
    changes AS (
        SELECT study_id, environment, seq, t_ms, action, window_class, modality,
            t_ms - lagInFrame(t_ms, 1, -100000) OVER (PARTITION BY study_id ORDER BY seq ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS gap_ms
        FROM otel.ux_events
        WHERE is_action AND has(changed, 'window')
    ),
    runs AS (
        SELECT *, sum(gap_ms >= 3000) OVER (PARTITION BY study_id ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run
        FROM changes
    )
SELECT study_id, any(environment) AS environment, run, any(modality) AS modality, count() AS changes,
    max(t_ms) - min(t_ms) AS duration_ms, groupArray(action) AS path, argMax(window_class, seq) AS final_window
FROM runs
GROUP BY study_id, run
;

-- Friction: an undo (or a 3D burr undo) right after an action, within 10 s.
CREATE OR REPLACE VIEW otel.ux_friction_undo AS
SELECT study_id, environment, t_ms, action AS undo, previous_action, t_ms - previous_ms AS after_ms
FROM (
    SELECT study_id, environment, seq, t_ms, action,
        lagInFrame(action) OVER (PARTITION BY study_id ORDER BY seq ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS previous_action,
        lagInFrame(t_ms) OVER (PARTITION BY study_id ORDER BY seq ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS previous_ms
    FROM otel.ux_events
    WHERE is_action
)
WHERE action IN ('undo', 'redo', 'volume-undo') AND previous_action != '' AND t_ms - previous_ms <= 10000
;

-- Friction: something switched on and off again within 2 s: the same control twice (a menu opened and
-- closed, a toggle undone) or an opener and its close. Scrolling, drawing and dragging are not toggles.
CREATE OR REPLACE VIEW otel.ux_friction_toggle AS
SELECT study_id, environment, t_ms, action, next_action, next_ms - t_ms AS within_ms
FROM (
    SELECT study_id, environment, seq, t_ms, action, input,
        leadInFrame(action) OVER (PARTITION BY study_id ORDER BY seq ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING) AS next_action,
        leadInFrame(t_ms) OVER (PARTITION BY study_id ORDER BY seq ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING) AS next_ms
    FROM otel.ux_events
    WHERE is_action
)
WHERE next_action != '' AND next_ms - t_ms <= 2000
    AND ((next_action = action AND input NOT IN ('wheel', 'drag') AND NOT match(action, '^(drag|draw|point|click|wheel|key-slice|view3d-(zoom|rotate|pan|burr|pick))'))
        OR (action, next_action) IN [('tool-3d', 'volume-close'), ('tool-assessment', 'assessment-close'), ('tool-help', 'help-close'),
            ('tool-export', 'key-escape'), ('export-video', 'export-close'), ('export-video', 'export-dismiss'), ('tool-inspector', 'key-escape')])
;

-- Friction: actions that changed nothing (no part of the screen or the settings).
CREATE OR REPLACE VIEW otel.ux_friction_noop AS
SELECT study_id, environment, t_ms, action, input, modality, tool
FROM otel.ux_events
WHERE noop
;

-- Friction: time on the toolbar before each toolbar click (since the pointer came onto the toolbar or
-- since the previous toolbar click): the search for a button.
CREATE OR REPLACE VIEW otel.ux_toolbar_hover AS
SELECT environment, action, count() AS clicks,
    round(quantileExact(0.5)(hover_ms)) AS median_hover_ms, round(quantileExact(0.9)(hover_ms)) AS p90_hover_ms, round(avg(hover_ms)) AS mean_hover_ms
FROM otel.ux_events
WHERE is_action AND hover_ms IS NOT NULL
GROUP BY environment, action
ORDER BY median_hover_ms DESC
;

-- Friction per action: how often it is used, changes nothing, is undone or switched straight back.
CREATE OR REPLACE VIEW otel.ux_friction AS
SELECT a.environment AS environment, a.action AS action, a.uses AS uses, a.noop_share AS noop_share,
    if(u.action = '', 0, u.undone) AS undone_after, if(t.action = '', 0, t.toggled) AS toggled_back, a.median_hover_ms AS median_hover_ms
FROM (
    SELECT environment, action, count() AS uses, round(countIf(noop) / count(), 3) AS noop_share,
        round(quantileExactIf(0.5)(hover_ms, hover_ms IS NOT NULL)) AS median_hover_ms
    FROM otel.ux_events WHERE is_action GROUP BY environment, action
) AS a
LEFT JOIN (SELECT environment, previous_action AS action, count() AS undone FROM otel.ux_friction_undo GROUP BY environment, action) AS u
    ON a.environment = u.environment AND a.action = u.action
LEFT JOIN (SELECT environment, action, count() AS toggled FROM otel.ux_friction_toggle GROUP BY environment, action) AS t
    ON a.environment = t.environment AND a.action = t.action
ORDER BY uses DESC
;

-- CPU and memory peaks: one row per process role per minute while sharing is on (electron/resource-monitor.cjs).
CREATE OR REPLACE VIEW otel.ux_perf AS
SELECT
    TraceId AS study_id,
    Timestamp AS ts,
    SpanAttributes['veacom.perf.role'] AS role,
    SpanAttributes['veacom.perf.signal'] AS signal,
    toUInt32OrNull(SpanAttributes['veacom.perf.cpu_pct']) AS cpu_pct,
    toUInt32OrNull(SpanAttributes['veacom.perf.ram_mib']) AS ram_mib,
    toUInt32OrZero(SpanAttributes['veacom.perf.ram_rise_mib']) AS ram_rise_mib,
    toUInt32OrNull(SpanAttributes['veacom.perf.process_hwm_mib']) AS process_hwm_mib,
    toUInt32OrZero(SpanAttributes['veacom.perf.cpu_hot_ms']) AS cpu_hot_ms,
    toUInt32OrZero(SpanAttributes['veacom.perf.peak_offset_ms']) AS peak_offset_ms,
    toUInt32OrZero(SpanAttributes['veacom.perf.samples']) AS samples,
    SpanAttributes['veacom.action'] AS action,
    if(arrayExists(prefix -> startsWith(ResourceAttributes['veacom.install_id'], prefix), (SELECT groupArray(install_prefix) FROM otel.ux_lab_installs)),
        'lab', ResourceAttributes['deployment.environment']) AS environment,
    ResourceAttributes['service.version'] AS version,
    ResourceAttributes['veacom.install_id'] AS install_id,
    ResourceAttributes['os.type'] AS os
FROM otel.otel_traces
WHERE ServiceName = 'veacom' AND SpanName = 'perf.resources'
;
