// Which action a click, a field change or a drop is, from the element's own hooks: `data-action`, else
// the `data-testid` the desktop checks already use (one vocabulary for tests and usage timings). Never
// from visible text, values or labels, which can hold patient data or typed text.
// Gestures on the images (drags, wheel, keys) are reported by the viewports themselves.
import { usage, type InputKind } from './tracker';

const INTERACTIVE = 'button, a[href], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"], [role="button"]';
const FIELD = 'input, select, textarea';
const ACTION = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** The stable action id for an element, or 'other' when it has none (the desktop checks look for those). */
export function actionId(element: Element): string {
  const explicit = element.getAttribute('data-action');
  if (explicit) return ACTION.test(explicit) ? explicit : 'other';
  const test = element.getAttribute('data-testid');
  if (!test) return 'other';
  // Series cards are named by their series id: the action is choosing one, not which.
  if (/^series-/.test(test) && !['series-find', 'series-open-study'].includes(test)) return 'series-pick';
  const id = test.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return ACTION.test(id) ? id : 'other';
}

let lastPointer = { time: -1, kind: 'mouse' as InputKind };
let lastKey = -1;
/** Whether a field was last reached by keyboard or by pointer. */
function fieldInput(): InputKind { return lastKey > lastPointer.time ? 'key' : lastPointer.kind; }
function pointerKind(event: Event): InputKind {
  const type = (event as PointerEvent).pointerType;
  return type === 'touch' ? 'touch' : 'mouse';
}

/** Listens on the whole document (capture phase, before the app's own handlers change anything). */
export function installUsageListeners(target: Document = document): () => void {
  const pointerDown = (event: PointerEvent) => { lastPointer = { time: performance.now(), kind: event.pointerType === 'touch' ? 'touch' : 'mouse' }; };
  const keyDown = () => { lastKey = performance.now(); };
  const click = (event: MouseEvent) => {
    const element = event.target instanceof Element ? event.target : null;
    const control = element?.closest(INTERACTIVE);
    // Clicks on empty space or on an image are not actions here (viewports report their own gestures).
    if (!control || control.matches(FIELD) || control.closest('[data-usage-ignore]')) return;
    const input: InputKind = event.detail === 0 ? 'key' : pointerKind(event);
    usage.action(actionId(control), input, { hoverMs: control.closest('[role="toolbar"]') ? usage.hoverTime() : undefined });
  };
  // A slider drag, a run of keystrokes in a number field or a checkbox click is one action, whatever
  // number of input and change events it fires. Values are never read.
  const field = (event: Event) => {
    const element = event.target instanceof Element ? event.target : null;
    if (!element?.matches(FIELD) || element.closest('[data-usage-ignore]')) return;
    usage.action(actionId(element), fieldInput(), { burst: true });
  };
  const drop = (event: DragEvent) => {
    const types = [...(event.dataTransfer?.types ?? [])];
    if (types.includes('application/x-veacom-series')) usage.action('series-drop', 'drop');
    else if (types.includes('Files')) usage.action('files-drop', 'drop');
  };
  target.addEventListener('pointerdown', pointerDown, true);
  target.addEventListener('keydown', keyDown, true);
  target.addEventListener('click', click, true);
  target.addEventListener('input', field, true);
  target.addEventListener('change', field, true);
  target.addEventListener('drop', drop, true);
  return () => {
    target.removeEventListener('pointerdown', pointerDown, true);
    target.removeEventListener('keydown', keyDown, true);
    target.removeEventListener('click', click, true);
    target.removeEventListener('input', field, true);
    target.removeEventListener('change', field, true);
    target.removeEventListener('drop', drop, true);
  };
}
