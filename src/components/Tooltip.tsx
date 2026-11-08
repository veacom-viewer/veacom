import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// One tooltip for every control with data-tooltip (name), data-shortcut (keys joined by "+") and data-tooltip-hint.
// It appears after a short hover delay, at once while moving along a row of controls, and immediately on
// keyboard focus. It is visual only: each control already carries the same name in aria-label.
// WCAG 1.4.13: the pointer can move onto it, Esc dismisses it, and it stays until hover or focus ends.
// Anything a tooltip says that a control's name does not must also be in the DOM (e.g. a .sr-only span).
interface Tip { text: string; shortcut?: string; hint?: string; anchor: DOMRect; }
const SHOW_DELAY = 450, WARM_MS = 600, HIDE_GRACE = 120, GAP = 6, MARGIN = 8;

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: HTMLElement | null = null, showTimer = 0, hideTimer = 0, warmUntil = 0, suppressed: HTMLElement | null = null;
    // The control whose tooltip is waiting out its delay.
    let pending: HTMLElement | null = null;
    const targetOf = (node: EventTarget | null) => node instanceof Element ? node.closest<HTMLElement>('[data-tooltip]') : null;
    const clear = () => { window.clearTimeout(showTimer); window.clearTimeout(hideTimer); pending = null; };
    const show = (target: HTMLElement) => {
      clear();
      const text = target.dataset.tooltip;
      if (!text || !target.isConnected || target.closest('[inert]') || target.getAttribute('aria-expanded') === 'true') return;
      current = target;
      setTip({ text, shortcut: target.dataset.shortcut || undefined, hint: target.dataset.tooltipHint || undefined, anchor: target.getBoundingClientRect() });
    };
    const hide = () => { clear(); if (current) warmUntil = performance.now() + WARM_MS; current = null; setTip(null); };
    const schedule = (target: HTMLElement) => {
      clear();
      if (current || performance.now() < warmUntil) show(target);
      else { pending = target; showTimer = window.setTimeout(() => show(target), SHOW_DELAY); }
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (element.current?.contains(event.target as Node)) { window.clearTimeout(hideTimer); return; }
      const target = targetOf(event.target);
      if (target && target === suppressed) return;
      suppressed = null;
      if (target === current && target) { window.clearTimeout(hideTimer); return; }
      if (target) schedule(target);
      else if (current) { window.clearTimeout(showTimer); hideTimer = window.setTimeout(hide, HIDE_GRACE); }
      else window.clearTimeout(showTimer);
    };
    const focusIn = (event: FocusEvent) => {
      const target = targetOf(event.target);
      if (target && target === event.target && target.matches(':focus-visible')) show(target);
      else if (current) hide();
    };
    const focusOut = (event: FocusEvent) => { if (current && event.target === current) hide(); };
    // Pressing a control hides its tooltip until the pointer leaves it.
    const down = (event: PointerEvent) => { const target = targetOf(event.target); if (target) suppressed = target; if (current || showTimer) hide(); };
    // Esc dismisses the tooltip and still does its usual job (close a menu, cancel a drawing…); Space too, which
    // presses the control or opens the quick menu over it.
    const key = (event: KeyboardEvent) => {
      const target = current ?? pending;
      if ((event.key !== 'Escape' && event.key !== ' ') || !target) return;
      suppressed = target; hide();
    };
    const away = () => { if (current) hide(); };
    document.addEventListener('pointerover', over, true);
    document.addEventListener('focusin', focusIn, true);
    document.addEventListener('focusout', focusOut, true);
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', away);
    window.addEventListener('resize', away);
    document.addEventListener('scroll', away, true);
    return () => {
      clear();
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('focusin', focusIn, true);
      document.removeEventListener('focusout', focusOut, true);
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', away);
      window.removeEventListener('resize', away);
      document.removeEventListener('scroll', away, true);
    };
  }, []);

  // Place below the control (above when there is no room), centred and kept inside the window.
  useLayoutEffect(() => {
    const node = element.current; if (!node || !tip) return;
    const { width, height } = node.getBoundingClientRect(), anchor = tip.anchor;
    let top = anchor.bottom + GAP;
    if (top + height > innerHeight - MARGIN) top = Math.max(MARGIN, anchor.top - GAP - height);
    const left = Math.min(Math.max(MARGIN, anchor.left + anchor.width / 2 - width / 2), Math.max(MARGIN, innerWidth - width - MARGIN));
    node.style.left = `${Math.round(left)}px`; node.style.top = `${Math.round(top)}px`; node.style.visibility = 'visible';
  }, [tip]);

  if (!tip) return null;
  return createPortal(<div ref={element} className="tooltip" aria-hidden="true" data-testid="tooltip" style={{ left: 0, top: 0, visibility: 'hidden' }}>
    <span>{tip.text}{tip.hint && <span className="tooltip-hint"> · {tip.hint}</span>}</span>
    {tip.shortcut && <span className="tooltip-keys">{tip.shortcut.split('+').map((part, index) => <kbd key={index}>{part}</kbd>)}</span>}
  </div>, document.body);
}
