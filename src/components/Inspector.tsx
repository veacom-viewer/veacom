import { useDeferredValue, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getTags } from '../api';
import { useTranslation } from '../i18n/react';
import { pagesBackwards } from '../imaging/paging';
import type { Series } from '../model';
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

type TagSource = { series?: Series; frame: number; onError: (error: unknown) => void };

function TagPanel({ series, frame, query, onQuery, onError }: TagSource & {
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
    const timer = setTimeout(async () => {
      try {
        const tags = await getTags(id, generation, frame, revision);
        if (current) setResult({ id, generation, revision, frame, tags: frameTags(tags) });
      } catch (error) {
        if (current) { setResult({ id, generation, revision, frame, tags: emptyTags }); reportError(error); }
      }
    }, sameSeries ? 150 : 0);
    return () => { current = false; clearTimeout(timer); };
  }, [id, generation, revision, frame]);

  const displayed = result && result.id === id && result.generation === generation && result.revision === revision && result.frame === frame ? result : null;
  const tags = displayed?.tags ?? emptyTags;
  const loading = Boolean(id && !displayed);
  return <div className="inspector-panel tags-panel" role="tabpanel" id="inspector-panel-tags" aria-labelledby="inspector-tab-tags" tabIndex={0} aria-busy={loading || query !== deferredQuery}>
    <div className="panel-heading"><h2>{t('inspector.metadata')}</h2>{tags.rows.length > 0 && <span className="count-badge">{tags.rows.length}</span>}</div>
    {series && series.dimensions[2] > 1 && <p className="tags-frame">{t('inspector.tagsFrame', { frame: pagesBackwards(series, { mode: 'source', plane: 'axial', oblique: undefined }) ? series.dimensions[2] - frame : frame + 1, total: series.dimensions[2] })}</p>}
    <label className="tag-search"><Search size={14} aria-hidden="true" /><input data-action="tags-search" aria-label={t('inspector.searchTags')} placeholder={t('inspector.searchPlaceholder')} value={query} onChange={event => onQuery(event.target.value)} /></label>
    {loading ? <div className="inspector-empty" role="status"><LoaderCircle className="spin" size={20} /><p>{t('inspector.readingMetadata')}</p></div> : <TagList tags={tags} query={deferredQuery} />}
  </div>;
}

export function Inspector({ open, showTags, inert, children, series, frame, onError }: TagSource & {
  open: boolean; showTags: boolean; inert: boolean; children: ReactNode;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  if (!open) return null;
  return <aside className="inspector" aria-label={t('inspector.label')} inert={inert || undefined}>
    {children}
    {showTags && <TagPanel series={series} frame={frame} onError={onError} query={query}
      onQuery={value => { setQuery(value); usage.touch('panel'); }} />}
  </aside>;
}
