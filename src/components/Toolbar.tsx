import { Fragment, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp } from './icons';
import { moveInGrid, nextIndex, planToolbar } from '../ui/navigation';
import type { ToolbarEntry } from '../ui/navigation';

// Toolbar building blocks. Names come from aria-label; the same text (plus shortcut) is shown by the
// shared TooltipLayer through data-tooltip / data-shortcut, so there are no native title tooltips here.

export function ToolButton({ icon, label, shortcut, hint, active, disabled = false, why, onClick, className = '', testId, action, popup, expanded, children, indicator }: {
  icon: ReactNode; label: string; shortcut?: string; hint?: string; active?: boolean; disabled?: boolean; onClick?: () => void;
  /** Why it cannot be used now: the button stays hoverable so the reason shows in its tooltip. */
  why?: string;
  className?: string; testId?: string; action?: string; popup?: 'menu' | 'dialog'; expanded?: boolean; children?: ReactNode; indicator?: boolean;
}) {
  const explained = disabled && Boolean(why);
  return <button type="button" className={`tool-button${active ? ' is-active' : ''}${popup ? ' has-popup' : ''}${explained ? ' is-unavailable' : ''} ${className}`} aria-label={label} aria-disabled={explained || undefined} aria-description={explained ? why : undefined}
    aria-pressed={popup ? undefined : active} aria-haspopup={popup} aria-expanded={popup ? Boolean(expanded) : undefined}
    aria-keyshortcuts={shortcut?.replace(/⌘/g, 'Meta').replace(/Ctrl/g, 'Control')} data-tooltip={label} data-shortcut={shortcut} data-tooltip-hint={explained ? why : hint}
    disabled={disabled && !explained} onClick={explained ? undefined : onClick} data-testid={testId} data-action={action}
    onKeyDown={popup ? event => { if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !expanded) { event.preventDefault(); event.stopPropagation(); onClick?.(); } } : undefined}>
    {icon}{children && <span className="tool-text">{children}</span>}{indicator && <ChevronDown className="popup-indicator" size={10} strokeWidth={2.5} aria-hidden="true" />}
  </button>;
}

/** The menu half of a split button (tool + choices). */
export function MenuChevron({ label, expanded, onClick, testId, disabled }: { label: string; expanded: boolean; onClick: () => void; testId?: string; disabled?: boolean }) {
  return <button type="button" className="tool-chevron" aria-label={label} aria-haspopup="menu" aria-expanded={expanded} data-tooltip={label} data-testid={testId}
    disabled={disabled} onClick={onClick}
    onKeyDown={event => { if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !expanded) { event.preventDefault(); event.stopPropagation(); onClick(); } }}>
    <ChevronDown size={12} strokeWidth={2.25} aria-hidden="true" />
  </button>;
}

const itemSelector = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';
const triggerOf = (element: HTMLElement | null) => element?.parentElement?.querySelector<HTMLElement>(':scope > [aria-haspopup], :scope > .split [aria-haspopup]') ?? null;
function restoreTrigger(element: HTMLElement) {
  const trigger = triggerOf(element);
  return () => {
    if (element.contains(document.activeElement) || document.activeElement === document.body) trigger?.focus({ preventScroll: true });
  };
}
function focusMenuItem(menu: HTMLDivElement | null) {
  if (!menu) return;
  const items = [...menu.querySelectorAll<HTMLButtonElement>(itemSelector)].filter(item => !item.disabled);
  (items.find(item => item.getAttribute('role') === 'menuitemradio' && item.getAttribute('aria-checked') === 'true') ?? items.at(0))?.focus();
  return restoreTrigger(menu);
}
function focusMenu(menu: HTMLDivElement | null) {
  if (!menu) return;
  menu.focus({ preventScroll: true });
  return restoreTrigger(menu);
}
function focusPopover(popover: HTMLDivElement | null) {
  if (!popover) return;
  (popover.querySelector<HTMLElement>('[data-autofocus]') ?? popover.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)'))?.focus();
  return restoreTrigger(popover);
}

/** A menu that owns the keyboard while open: arrows, Home/End, Esc (close, back to the trigger), Tab (close).
 * `focusItem` false: the menu itself takes focus on opening, so no item is ringed until the arrow keys reach one. */
export function Menu({ label, onClose, className = '', align, children, testId, focusItem = true }: {
  label: string; onClose: () => void; className?: string; align?: 'right'; children: ReactNode; testId?: string; focusItem?: boolean;
}) {
  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(itemSelector)];
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === 'Tab') { onClose(); return; }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const index = nextIndex(items.indexOf(document.activeElement as HTMLButtonElement), event.key, items.map(item => !item.disabled), 'vertical');
    items[index]?.focus();
  };
  return <div ref={focusItem ? focusMenuItem : focusMenu} role="menu" aria-label={label} tabIndex={-1} className={`popover-menu${align === 'right' ? ' align-right' : ''} ${className}`} onKeyDown={keyDown} data-testid={testId}>{children}</div>;
}

export function MenuItem({ icon, children, onClick, disabled = false, shortcut, meta, testId, action, checked, kind = 'item' }: {
  icon?: ReactNode; children: ReactNode; onClick: () => void; disabled?: boolean; shortcut?: string; meta?: string; action?: string; testId?: string;
  checked?: boolean; kind?: 'item' | 'radio' | 'checkbox';
}) {
  const role = kind === 'radio' ? 'menuitemradio' : kind === 'checkbox' ? 'menuitemcheckbox' : 'menuitem';
  return <button className="menu-item" type="button" role={role} tabIndex={-1} aria-checked={kind === 'item' ? undefined : Boolean(checked)}
    onClick={onClick} disabled={disabled} data-testid={testId} data-action={action}>
    {kind !== 'item' && <span className="menu-check" aria-hidden="true">{checked && <Check size={14} strokeWidth={2.5} />}</span>}
    {icon ?? (kind === 'item' ? <span className="menu-icon-spacer" /> : null)}
    <span className="menu-label">{children}</span>
    {meta && <span className="menu-meta">{meta}</span>}
    {shortcut && <kbd>{shortcut}</kbd>}
  </button>;
}

export const MenuHeading = ({ children }: { children: ReactNode }) => <div className="menu-heading" role="presentation">{children}</div>;
export const MenuDivider = () => <div className="menu-divider" role="separator" />;

/** A small non-modal dialog under a toolbar button (settings, layout picker). Esc or focus leaving closes it. */
export function Popover({ label, onClose, className = '', align, children, testId }: {
  label: string; onClose: () => void; className?: string; align?: 'right'; children: ReactNode; testId?: string;
}) {
  return <div ref={focusPopover} role="dialog" aria-label={label} className={`popover-menu popover-panel${align === 'right' ? ' align-right' : ''} ${className}`} data-testid={testId}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}
    // Focus moving to the trigger is left to the trigger's own toggle.
    onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.parentElement?.contains(event.relatedTarget)) onClose(); }}>{children}</div>;
}

/** 5 × 5 layout chooser: hover or arrow keys preview the rows × columns, Enter or click applies. */
/** The layout button's picture, as in VEAcom Next: the grid now on screen; one pane is a frame with a dashed cross. */
export function LayoutIcon({ rows, columns, size = 18 }: { rows: number; columns: number; size?: number }) {
  const [left, top, width, height] = [2.5, 3.5, 19, 17];
  const lines: ReactNode[] = [];
  if (rows === 1 && columns === 1) {
    lines.push(<path key="cross" d={`M${left + width / 2} ${top + 2.5}V${top + height - 2.5}M${left + 2.5} ${top + height / 2}H${left + width - 2.5}`} strokeWidth={1.2} strokeDasharray="2 2" opacity={0.6} />);
  } else {
    for (let column = 1; column < columns; column++) lines.push(<path key={`c${column}`} d={`M${left + width * column / columns} ${top}V${top + height}`} />);
    for (let row = 1; row < rows; row++) lines.push(<path key={`r${row}`} d={`M${left} ${top + height * row / rows}H${left + width}`} />);
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
    <rect x={left} y={top} width={width} height={height} rx={1.5} />{lines}
  </svg>;
}

export function LayoutPicker({ layout, onChoose, label, choiceLabel }: {
  layout: [number, number]; onChoose: (rows: number, columns: number) => void; label: string; choiceLabel: (rows: number, columns: number) => string;
}) {
  const [preview, setPreview] = useState<[number, number]>(layout);
  const grid = useRef<HTMLDivElement>(null);
  const focusCell = (rows: number, columns: number) => grid.current?.querySelector<HTMLElement>(`[data-layout="${rows}x${columns}"]`)?.focus();
  return <div className="layout-picker">
    <div className="layout-readout" aria-live="polite"><span>{label}</span><strong>{preview[0]} × {preview[1]}</strong></div>
    <div ref={grid} className="layout-grid" role="group" aria-label={label} onPointerLeave={() => setPreview(layout)}
      onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const next = moveInGrid(preview, event.key, [5, 5]); setPreview(next); focusCell(...next);
      }}>
      {Array.from({ length: 25 }, (_, index) => {
        const row = Math.floor(index / 5) + 1, column = index % 5 + 1;
        const inPreview = row <= preview[0] && column <= preview[1], current = row === layout[0] && column === layout[1];
        return <button key={index} type="button" aria-label={choiceLabel(row, column)} aria-pressed={current} data-layout={`${row}x${column}`}
          data-autofocus={current ? '' : undefined} tabIndex={row === preview[0] && column === preview[1] ? 0 : -1}
          className={`${inPreview ? 'in-preview' : ''}${current ? ' is-selected' : ''}`}
          onPointerEnter={() => setPreview([row, column])} onFocus={() => setPreview([row, column])} data-action={`layout-${row}x${column}`} onClick={() => onChoose(row, column)} />;
      })}
    </div>
  </div>;
}

export interface ToolbarItem { id: string; group: string; priority?: number; node: ReactNode; }

/** One toolbar row: arrow keys move between controls (one Tab stop), and when the window is too narrow
 * the lowest-priority items move into a second row, opened with the More button, instead of being cut off. */
export function Toolbar({ label, start, end, moreLabel }: {
  label: string; start: ToolbarItem[]; end: ToolbarItem[]; moreLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [secondRow, setSecondRow] = useState(false);
  const current = useRef<HTMLElement | null>(null);
  const items = [...start, ...end];

  const controls = () => [...ref.current!.querySelectorAll<HTMLElement>('button, select')]
    .filter(element => !element.closest('.popover-menu, [hidden]'));
  // Exactly one control is in the Tab order: the last one used, else the first enabled one.
  const syncTabStops = () => {
    const all = controls();
    if (!current.current || !all.includes(current.current) || (current.current as HTMLButtonElement).disabled) current.current = all.find(element => !(element as HTMLButtonElement).disabled) ?? null;
    for (const element of all) {
      const tabIndex = element === current.current ? 0 : -1;
      if (element.tabIndex !== tabIndex) element.tabIndex = tabIndex;
    }
  };

  // Widths are measured while an item is shown and remembered while it sits in the second row.
  const plan = useEffectEvent(() => {
    const toolbar = ref.current; if (!toolbar) return;
    for (const element of toolbar.querySelectorAll<HTMLElement>('[data-toolbar-item]')) widths.current.set(element.dataset.toolbarItem!, element.getBoundingClientRect().width + 2);
    const style = getComputedStyle(toolbar);
    const available = toolbar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const entries: ToolbarEntry[] = items.map(item => ({ id: item.id, width: widths.current.get(item.id) ?? 0, priority: item.priority }));
    entries.push({ id: '__dividers', width: new Set(items.map(item => item.group)).size * 13 });
    // 40 px: the More arrow (28) and the divider before it (9), with the gaps between them.
    const next = planToolbar(entries, available, 40);
    setHidden(previous => previous.size === next.size && [...next].every(id => previous.has(id)) ? previous : next);
    if (!next.size) setSecondRow(false);
  });

  const structure = items.map(item => `${item.id}:${item.group}:${item.priority ?? ''}`).join('|');
  useLayoutEffect(() => {
    const toolbar = ref.current!;
    plan();
    syncTabStops();
    const controlsChanged = new MutationObserver(syncTabStops);
    controlsChanged.observe(toolbar, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'hidden'] });
    const resized = new ResizeObserver(() => plan());
    resized.observe(toolbar);
    return () => { controlsChanged.disconnect(); resized.disconnect(); };
  }, [structure, syncTabStops]);

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (target.closest('.popover-menu') || target.matches('select, input')) return;
    const all = controls(), index = all.indexOf(target);
    if (index < 0) return;
    event.preventDefault();
    // -1 when every control is disabled.
    const to = nextIndex(index, event.key, all.map(element => !(element as HTMLButtonElement).disabled), 'horizontal');
    if (to < 0) return;
    const next = all[to];
    current.current = next; syncTabStops(); next.focus();
  };

  // Items that do not fit go to a second row under the first (as in VEAcom Next), opened with the arrow right after the
  // last tool shown on the left, where the folded tools come from, rather than past the right-hand tools at the far right,
  // where it is easy to miss. A divider keeps it apart from that tool's own menu arrow; dividers separate the groups in
  // each row.
  const row = (list: ToolbarItem[]) => list.map((item, index, shown) => <Fragment key={item.id}>
    {index > 0 && shown[index - 1].group !== item.group && <span className="toolbar-divider" aria-hidden="true" />}
    <div className="toolbar-item" data-toolbar-item={item.id}>{item.node}</div>
  </Fragment>);
  const render = (list: ToolbarItem[]) => row(list.filter(item => !hidden.has(item.id)));
  const overflowed = items.filter(item => hidden.has(item.id));
  return <>
    <div ref={ref} className="toolbar" role="toolbar" aria-label={label} onKeyDown={keyDown}
      onFocus={event => { const target = event.target as HTMLElement; if (!target.closest('.popover-menu') && controls().includes(target)) { current.current = target; syncTabStops(); } }}>
      {render(start)}
      {overflowed.length > 0 && <>
        <span className="toolbar-divider" aria-hidden="true" />
        <div className="toolbar-item"><button type="button" className="tool-button toolbar-more" aria-label={moreLabel} aria-expanded={secondRow} data-testid="tool-more" data-tooltip={moreLabel}
          onClick={() => setSecondRow(open => !open)}>{secondRow ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button></div>
      </>}
      <div className="toolbar-spacer" />
      {render(end)}
    </div>
    {secondRow && overflowed.length > 0 && <div className="toolbar toolbar-second" role="toolbar" aria-label={moreLabel}>{row(overflowed)}</div>}
  </>;
}
