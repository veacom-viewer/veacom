import { useDeferredValue, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getTags } from '../api';
import { useTranslation } from '../i18n/react';
import { shownSlice } from '../imaging/paging';
import type { Joined, Series } from '../model';
import { usage } from '../usage/tracker';
import { LoaderCircle, Search } from './icons';

type Tag = Record<string, unknown>;
function frameTags(rows: Tag[]) {
  let index: string[] | undefined;
  return {
    rows,
    matches(row: number, needle: string) {
      if (!needle) return true;
      index ??= rows.map(tag => JSON.stringify(tag).toLowerCase());
      return index[row].includes(needle);
    },
  };
}
type FrameTags = ReturnType<typeof frameTags>;
const emptyTags = frameTags([]);

function TagList({ tags, query }: { tags: FrameTags; query: string }) {
  const { t } = useTranslation();
  const needle = query.toLowerCase();
  return <div className="tag-list">{tags.rows.map((row, i) => {
    if (!tags.matches(i, needle)) return null;
    return <div className="tag-row" key={i}><span>{String(row.name ?? row.keyword ?? row.tag ?? i)}</span>
      <strong>{String(row.value ?? row.values ?? '')}</strong>
      {row.tag != null && <small>{String(row.tag)}{row.vr ? <span className="tag-vr" title={t('inspector.vr')}> · {String(row.vr)}</span> : null}</small>}
    </div>;
  })}{!tags.rows.length && <p className="muted-copy">{t('inspector.selectSeriesForTags')}</p>}</div>;
}

type TagSource = { series?: Series; frame: number; onError: (error: unknown) => void;
  /** The series is a stack paged with its reference image, or that image: frames are numbered over both. */
  joined?: Joined | null };

/** The acquired frame's number and the total, as the pane counts them (imaging/paging.ts). */
function numbered(series: Series, frame: number, joined?: Joined | null): { frame: number; total: number } {
  const shown = shownSlice(series, { mode: 'source', plane: 'axial', oblique: undefined }, frame, series.dimensions[2], joined);
  return { frame: shown.number, total: shown.total };
}

function TagPanel({ series, frame, joined, query, onQuery, onError }: TagSource & {
  query: string; onQuery: (query: string) => void;
}) {
  const { t } = useTranslation();
  const deferredQuery = useDeferredValue(query);
  const reportError = useEffectEvent(onError);
  const id = series?.id, generation = series?.engineGeneration, revision = series?.catalogRevision;
  const lastRequest = useRef<{ id: string; generation?: number; revision?: number } | null>(null);
  const [result, setResult] = useState<{ id: string; generation?: number; revision?: number; frame: number; tags: FrameTags } | null>(null);
  useEffect(() => {
    if (!id) { lastRequest.current = null; return; }
    let current = true;
    const sameSeries = lastRequest.current?.id === id && lastRequest.current.generation === generation && lastRequest.current.revision === revision;
    lastRequest.current = { id, generation, revision };
    const timer = setTimeout(() => {
      getTags(id, generation, frame, revision).then(tags => {
        if (current) setResult({ id, generation, revision, frame, tags: frameTags(tags) });
      }).catch((error: unknown) => {
        if (current) { setResult({ id, generation, revision, frame, tags: emptyTags }); reportError(error); }
      });
    }, sameSeries ? 150 : 0);
    return () => { current = false; clearTimeout(timer); };
  }, [id, generation, revision, frame]);

  const displayed = result && result.id === id && result.generation === generation && result.revision === revision && result.frame === frame ? result : null;
  const tags = displayed?.tags ?? emptyTags;
  const loading = Boolean(id && !displayed);
  return <div className="inspector-panel tags-panel" role="tabpanel" id="inspector-panel-tags" aria-labelledby="inspector-tab-tags" tabIndex={0} aria-busy={loading || query !== deferredQuery}>
    <div className="panel-heading"><h2>{t('inspector.metadata')}</h2>{tags.rows.length > 0 && <span className="count-badge">{tags.rows.length}</span>}</div>
    {series && (series.dimensions[2] > 1 || joined) && <p className="tags-frame">{t('inspector.tagsFrame', numbered(series, frame, joined))}</p>}
    <label className="tag-search"><Search size={14} aria-hidden="true" /><input data-action="tags-search" aria-label={t('inspector.searchTags')} placeholder={t('inspector.searchPlaceholder')} value={query} onChange={event => onQuery(event.target.value)} /></label>
    {loading ? <div className="inspector-empty" role="status"><LoaderCircle className="spin" size={20} /><p>{t('inspector.readingMetadata')}</p></div> : <TagList tags={tags} query={deferredQuery} />}
  </div>;
}

export function Inspector({ open, showTags, inert, children, series, frame, joined, onError }: TagSource & {
  open: boolean; showTags: boolean; inert: boolean; children: ReactNode;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  if (!open) return null;
  return <aside className="inspector" aria-label={t('inspector.label')} inert={inert || undefined}>
    {children}
    {showTags && <TagPanel series={series} frame={frame} joined={joined} onError={onError} query={query}
      onQuery={value => { setQuery(value); usage.touch('panel'); }} />}
  </aside>;
}
