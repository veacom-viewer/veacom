// The import window, as in VEAcom Next, in a view of its own laid over the application window
// (electron/import-view.cjs): drives (a CD/DVD drive even with no disc), the usual places and pinned folders on the
// left, a folder's subfolders and ZIP archives on the right. Several folders and archives can be ticked and
// opened together; with none ticked, Open imports the folder shown. The application page cannot reach this view, so
// only what the user opens here becomes readable. Its code is first-party only, with no packages
// (tests/import-window.test.ts), so a compromised dependency of the application cannot drive it either.
import { isLocale, setLocale, t, type MessageKey } from '../i18n';
import { icon, type IconName } from './icons';
import '../fonts.css';
import '../theme.css';
import '../styles.css';
import './import-window.css';

type Input = 'mouse' | 'key' | 'touch';
interface Folder {
  path: string; parent: string | null; files: number; dicomdir: boolean; truncated: boolean;
  items: Array<{ name: string; path: string; kind: 'folder' | 'archive' }>;
}
interface Places {
  drives: Array<{ path: string; label: string; kind: 'fixed' | 'removable' | 'disc' | 'network'; ready: boolean }>;
  home: Array<{ key: 'home' | 'desktop' | 'downloads' | 'documents'; path: string }>;
}
interface Bridge {
  locale?: string; start?: string;
  places(): Promise<Places>;
  browse(folder: string): Promise<Folder>;
  open(paths: string[]): Promise<void>;
  close(): Promise<void>;
  action(id: string, input: Input): void;
}
const bridge = (window as unknown as { veacomImport?: Bridge }).veacomImport;

// This origin's own storage: the application page cannot write it.
const PINNED_KEY = 'veacom:pinned-folders', LAST_KEY = 'veacom:import-folder';
const stored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* kept for this window only */ } };
const readPinned = (): string[] => {
  try { const value = JSON.parse(stored(PINNED_KEY) ?? '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 20) : []; }
  catch { return []; }
};
const lastPart = (folder: string) => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;
const DRIVE_ICONS: Record<Places['drives'][number]['kind'], IconName> = { fixed: 'hardDrive', removable: 'usb', disc: 'disc', network: 'network' };

type Child = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value === undefined) continue;
    if (name === 'className') element.className = String(value);
    else element.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children) if (child) element.append(child);
  return element;
}
const button = (attributes: Record<string, string | boolean | undefined>, onClick: () => void, ...children: Child[]) => {
  const element = h('button', { type: 'button', ...attributes }, ...children);
  element.addEventListener('click', onClick);
  return element;
};

let places: Places | null = null;
let folder: Folder | null = null;
let selected = new Set<string>();
let pinned = readPinned();
let error = '';
let busy = false;
let navigation = 0;
let shownAt = Infinity;
// The application page decides when this window appears: a click it timed to land there as it does is not the
// user's choice, so Open waits a moment.
const SETTLE_MS = 500;

const dialog = h('dialog', { className: 'dialog import-dialog', 'aria-labelledby': 'import-title', 'data-testid': 'import-dialog' });
const nav = h('nav', { className: 'import-places' });
const pathRow = h('div', { className: 'import-path' });
const errorLine = h('p', { className: 'import-error', role: 'alert' });
const list = h('ul', { className: 'import-list', 'data-testid': 'import-list' });
const filesLine = h('p', { className: 'import-files' });
const browser = h('section', { className: 'import-browser' }, pathRow, errorLine, list, filesLine);
const count = h('span', { className: 'import-count' });
const openButton = button({ className: 'primary-button', 'data-action': 'import-open', 'data-testid': 'import-open' }, () => void open());

const close = () => { void bridge?.close(); };

async function go(target: string): Promise<boolean> {
  if (!bridge) return false;
  const ticket = ++navigation;
  error = '';
  try {
    const listed = await bridge.browse(target);
    if (ticket !== navigation) return false;
    folder = listed; selected = new Set();
    store(LAST_KEY, listed.path);
    renderPlaces(); renderFolder(); renderFooter();
    return true;
  } catch {
    if (ticket === navigation) { error = t('import.unreadable', { folder: target }); renderFolder(); }
    return false;
  }
}

function toggle(path: string, row: HTMLLIElement, box: HTMLInputElement) {
  if (selected.has(path)) selected.delete(path); else selected.add(path);
  row.className = selected.has(path) ? 'is-selected' : '';
  box.checked = selected.has(path);
  renderFooter();
}

function togglePin() {
  if (!folder) return;
  const here = folder.path;
  pinned = pinned.includes(here) ? pinned.filter(item => item !== here) : [...pinned, here];
  store(PINNED_KEY, JSON.stringify(pinned));
  renderPlaces(); renderPath();
}

async function open() {
  if (!bridge || !folder || busy || performance.now() - shownAt < SETTLE_MS) return;
  const paths = selected.size ? [...selected] : [folder.path];
  busy = true; renderFooter();
  // The main process closes this window once the paths are authorized for the application.
  try { await bridge.open(paths); }
  catch (cause) { error = cause instanceof Error ? cause.message : String(cause); busy = false; renderFolder(); renderFooter(); }
}

function placeButton(path: string, label: string, glyph: SVGSVGElement, extra?: Node) {
  const place = button({ className: `import-place${folder?.path === path ? ' is-current' : ''}`, 'data-action': 'import-place', title: path }, () => void go(path), glyph, h('span', {}, label));
  return h('li', {}, place, extra);
}

function renderPlaces() {
  const drives = (places?.drives ?? []).map(drive => drive.ready
    ? placeButton(drive.path, drive.label, icon(DRIVE_ICONS[drive.kind], 15))
    : h('li', {}, h('span', { className: 'import-place is-empty', title: t('import.noDisc') }, icon(DRIVE_ICONS[drive.kind], 15), h('span', {}, `${drive.label} · ${t('import.noDisc')}`))));
  const usual = (places?.home ?? []).map(place => placeButton(place.path, t(`import.place.${place.key}` as MessageKey), icon('folder', 15)));
  const pins = pinned.map(path => placeButton(path, lastPart(path), icon('pin', 15),
    button({ className: 'icon-button import-unpin', 'aria-label': t('import.unpin', { folder: lastPart(path) }), 'data-action': 'import-pin' }, () => {
      pinned = pinned.filter(item => item !== path); store(PINNED_KEY, JSON.stringify(pinned)); renderPlaces(); renderPath();
    }, icon('pinOff', 13))));
  nav.replaceChildren(h('h3', {}, t('import.drives')), h('ul', {}, ...drives), h('h3', {}, t('import.usual')), h('ul', {}, ...usual),
    ...(pins.length ? [h('h3', {}, t('import.pinned')), h('ul', {}, ...pins)] : []));
}

function renderPath() {
  const here = folder;
  const isPinned = Boolean(here && pinned.includes(here.path));
  pathRow.replaceChildren(
    button({ className: 'icon-button', 'data-action': 'import-up', 'aria-label': t('import.up'), disabled: !here?.parent }, () => { if (here?.parent) void go(here.parent); }, icon('arrowUp', 16)),
    h('span', { className: 'import-current', title: here?.path }, here?.path ?? '…'),
    button({ className: 'icon-button', 'data-action': 'import-pin', 'aria-pressed': String(isPinned), 'aria-label': isPinned ? t('import.unpinHere') : t('import.pinHere'), disabled: !here },
      togglePin, icon(isPinned ? 'pinOff' : 'pin', 16)));
}

function row(item: Folder['items'][number]) {
  const box = h('input', { type: 'checkbox', 'aria-label': t('import.select', { name: item.name }), 'data-action': 'import-list' });
  box.checked = selected.has(item.path);
  const line = h('li', { className: selected.has(item.path) ? 'is-selected' : '' });
  const entry = button({ className: 'import-entry', 'data-kind': item.kind, 'data-action': 'import-list' },
    () => { if (item.kind === 'folder') void go(item.path); else toggle(item.path, line, box); }, icon(item.kind === 'folder' ? 'folder' : 'archive', 16), h('span', {}, item.name));
  box.addEventListener('change', () => toggle(item.path, line, box));
  line.append(box, entry);
  return line;
}

function renderFolder() {
  renderPath();
  browser.setAttribute('aria-label', folder?.path ?? t('import.title'));
  errorLine.hidden = !error;
  errorLine.textContent = error;
  list.replaceChildren(...(folder?.items ?? []).map(row), ...(folder && !folder.items.length ? [h('li', { className: 'import-none' }, t('import.noFolders'))] : []));
  filesLine.hidden = !folder;
  filesLine.textContent = folder ? `${folder.dicomdir ? t('import.dicomdir', { count: folder.files }) : t('import.files', { count: folder.files })}${folder.truncated ? ` · ${t('import.truncated')}` : ''}` : '';
}

function renderFooter() {
  count.textContent = selected.size ? t('import.selected', { count: selected.size }) : folder ? t('import.thisFolder', { folder: lastPart(folder.path) }) : '';
  openButton.disabled = !folder || busy;
}

// The window's clicks go to the application's usage timings, by their action id only (never names or paths).
function relayActions() {
  let pointer: Input = 'mouse', pointerAt = -1, keyAt = -1;
  document.addEventListener('pointerdown', event => { pointer = event.pointerType === 'touch' ? 'touch' : 'mouse'; pointerAt = performance.now(); }, true);
  document.addEventListener('keydown', () => { keyAt = performance.now(); }, true);
  document.addEventListener('click', event => {
    const control = event.target instanceof Element ? event.target.closest<HTMLElement>('button[data-action]') : null;
    if (control?.dataset.action) bridge?.action(control.dataset.action, event.detail === 0 ? 'key' : pointer);
  }, true);
  document.addEventListener('change', event => {
    const field = event.target instanceof HTMLInputElement ? event.target : null;
    if (field?.dataset.action) bridge?.action(field.dataset.action, keyAt > pointerAt ? 'key' : pointer);
  }, true);
}

async function start() {
  if (!bridge) return;
  if (isLocale(bridge.locale)) setLocale(bridge.locale);
  // Laid over the whole window, the dialog sits below the application's toolbar like its own dialogs (styles.css).
  document.documentElement.dataset.titlebar = 'toolbar';
  dialog.append(
    h('header', {}, icon('folderOpen', 20), h('h2', { id: 'import-title' }, t('import.title')),
      button({ className: 'icon-button', 'aria-label': t('import.close'), 'data-action': 'import-cancel' }, close, icon('x', 18))),
    h('div', { className: 'import-body' }, nav, browser),
    h('footer', {}, count, button({ className: 'secondary-button', 'data-action': 'import-cancel' }, close, t('import.cancel')), openButton));
  nav.setAttribute('aria-label', t('import.places'));
  openButton.textContent = t('import.open');
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Backspace' && folder?.parent && !(event.target as HTMLElement).matches('input[type="text"]')) { event.preventDefault(); void go(folder.parent); }
  });
  relayActions();
  renderPlaces(); renderFolder(); renderFooter();
  document.body.append(dialog);
  dialog.showModal();
  shownAt = performance.now();

  const disc = bridge.start === 'disc';
  const last = disc ? null : stored(LAST_KEY);
  // The last folder shows at once; the drives' kinds can take a moment longer to read.
  const shown = last ? go(last) : Promise.resolve(false);
  try { places = await bridge.places(); }
  catch { places = { drives: [], home: [] }; }
  renderPlaces();
  const drive = places.drives.find(item => item.kind === 'disc' && item.ready);
  if (disc && drive) void go(drive.path);
  // A last folder that is gone, or no longer allowed, falls back to home.
  else if (!(await shown)) void go(places.home.at(0)?.path ?? places.drives.at(0)?.path ?? '/');
}

void start();
