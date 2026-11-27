import { useState, type ReactNode } from 'react';
import {
  ChevronRight, Circle, Globe, Hexagon, MoveUpRight, Pipette, Radius, Ruler, Spline, Square, TriangleRight, Type,
} from './icons';
import { useTranslation } from '../i18n/react';
import { useAnnotationSummary } from '../imaging/useAnnotationSummary';
import { displayWindowWidth } from '../imaging/viewState';
import type { Annotation, Tool, VoiFunction, Volume } from '../model';
import { general } from '../ui/overlayCorners';
import { ROI_TOOLS, type DisplaySection } from '../ui/workspaceHelpers';

export const MEASURE_ICONS: Partial<Record<Tool, typeof Ruler>> = {
  length: Ruler, angle: TriangleRight, cobb: Radius, rectangle: Square, ellipse: Circle,
  polygon: Hexagon, polyline: Spline, sphere: Globe, probe: Pipette, arrow: MoveUpRight, text: Type,
};

/** A measurement's icon; on the toolbar a region gets a small "ROI" tag, so it is not taken for the layout button. */
export function measureIcon(tool: Tool, size = 18, tagged = false) {
  const Icon = MEASURE_ICONS[tool] ?? Ruler;
  return tagged && ROI_TOOLS.has(tool)
    ? <span className="tool-icon-tagged"><Icon size={size} /><span className="tool-icon-tag">ROI</span></span>
    : <Icon size={size} />;
}

export function WindowInput({ kind, value, curve, disabled, change }: {
  kind: 'width' | 'level';
  value: number;
  curve?: VoiFunction;
  disabled: boolean;
  change: (value: number) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const label = t(kind === 'width' ? 'inspector.windowWidth' : 'inspector.windowLevel');
  return <label>{label}<input data-action={kind === 'width' ? 'window-width-input' : 'window-level-input'} aria-label={label} type="number" step="any"
    min={kind === 'width' ? (curve ? 0 : 1) : undefined} disabled={disabled} value={draft ?? general(value)}
    onBlur={() => setDraft(null)} onChange={event => {
      const field = event.currentTarget, next = field.valueAsNumber;
      setDraft(field.value);
      if (Number.isFinite(next) && (kind === 'level' || displayWindowWidth(next, curve) === next)) change(next);
    }} /></label>;
}

/** One collapsible group in the display panel (accordion pattern: heading + button + region). */
export function PanelSection({ id, title, open, onToggle, children }: {
  id: DisplaySection;
  title: string;
  open: boolean;
  onToggle: (id: DisplaySection) => void;
  children: ReactNode;
}) {
  return <section className={`panel-section${open ? ' is-open' : ''}`} data-section={id}>
    <h3 className="panel-section-title"><button type="button" aria-expanded={open} aria-controls={`section-${id}`} id={`section-${id}-toggle`} onClick={() => onToggle(id)}>
      <ChevronRight size={14} className="section-chevron" aria-hidden="true" /><span>{title}</span></button></h3>
    <div className="panel-section-body" id={`section-${id}`} role="region" aria-labelledby={`section-${id}-toggle`} hidden={!open}>{children}</div>
  </section>;
}

export function AnnotationSummary({ annotation, volume }: { annotation: Annotation; volume?: Volume }) {
  const { t } = useTranslation();
  const summary = useAnnotationSummary(annotation, volume);
  // The main value leads; further statistics wrap as whole items ("σ 295.4" never splits). A note wraps as text.
  const parts = (summary || t(`tool.${annotation.type}` as const)).split(' · ');
  if (parts.length === 1) return <span className="stat-primary">{parts[0]}</span>;
  return <>{parts.map((part, index) => <span key={index} className={index ? 'stat' : 'stat-primary'}>{part}</span>)}</>;
}
