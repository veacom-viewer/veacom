import { useEffect, useRef } from 'react';
import licence from '../../LICENSE?raw';
import { CircleHelp, X } from './icons';
import type { MessageKey, Translator } from '../i18n';
import { useTranslation } from '../i18n/react';
import { modifierKey } from '../ui/presets';

// Every shortcut the window keydown handler, the viewport and the mouse handling support (App.tsx, Viewport.tsx).
// A shortcut is a list of alternatives; each alternative is a list of keys pressed together.
type Keys = string[][];
type Row = [label: string, keys: Keys];

function groups(t: Translator): { title: MessageKey; rows: Row[] }[] {
  const mod = modifierKey(navigator.platform), alt = mod === '⌘' ? '⌥' : 'Alt', shift = mod === '⌘' ? '⇧' : 'Shift';
  return [
    { title: 'help.group.file', rows: [
      [t('help.openFolder'), [[mod, 'O']]], [t('help.export'), [[mod, 'E']]], [t('toolbar.exportMedia'), [[mod, shift, 'E']]],
      [t('help.copyImage'), [[mod, 'C']]], [t('help.copyLayout'), [[mod, shift, 'C']]],
    ] },
    { title: 'help.group.tools', rows: [
      [t('tool.window'), [['W']]], [t('tool.scroll'), [['S']]], [t('tool.pan'), [['P']]], [t('tool.zoom'), [['Z']]], [t('tool.crosshair'), [['C']]],
    ] },
    { title: 'help.group.navigate', rows: [
      [t('help.slices'), [['↑'], ['↓'], [t('help.wheelKey')]]], [t('help.pageSlices'), [['PgUp'], ['PgDn']]],
      [t('help.zoomKeys'), [['+'], ['−']]], [t('help.zoomWheel'), [[mod, t('help.wheelKey')]]],
      [t('help.panKeys'), [[shift, t('help.arrowKeys')]]], [t('help.zoomPan'), [[t('help.zoomPanKeys')]]],
      [t('help.resetView'), [[t('help.doubleClickKey')]]], [t('help.mpr'), [['M']]], [t('help.fusionDrag'), [[mod, t('help.dragKey')]]], [t('help.quickMenu'), [[t('help.spaceKey')]]],
    ] },
    { title: 'help.group.window', rows: [
      [t('toolbar.dicomWindow'), [['0']]], [t('preset.fullRange'), [['1']]], [t('help.presetKeys'), [['2'], ['…'], ['9']]],
      [t('toolbar.autoWindow'), [[shift, 'A']]], [t('inspector.invert'), [['I']]],
    ] },
    { title: 'help.group.measure', rows: [
      [t('tool.length'), [['L']]], [t('tool.angle'), [['A']]], [t('tool.rectangle'), [['R']]], [t('tool.ellipse'), [['E']]], [t('tool.sphere'), [['V']]], [t('tool.text'), [['T']]],
      [t('help.clickMeasure'), [[t('help.clickClickKey')]]], [t('help.finishShape'), [['Enter']]], [t('help.cancelShape'), [['Esc']]], [t('help.deleteSelected'), [['Delete']]],
      [t('help.undo'), [[mod, 'Z'], [mod, shift, 'Z']]],
    ] },
    { title: 'help.group.toggle', rows: [
      [t('toolbar.showOverlay'), [['F12']]], [t('toolbar.showReferences'), [[mod, 'F12']]], [t('toolbar.patientInfo'), [[shift, 'F12']]],
      [t('toolbar.measurementsShown'), [[alt, 'F12']]], [t('toolbar.showTags'), [[mod, alt, 'T']]], [t('help.help'), [['?'], ['F1']]],
    ] },
  ];
}

/** `onCheckUpdates`: absent where the app cannot update itself (the browser build). */
export function HelpDialog({ onClose, onCheckUpdates }: { onClose: () => void; onCheckUpdates?: () => void }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const all = groups(t), columns = [all.slice(0, 3), all.slice(3)];
  return <dialog ref={dialog} className="dialog shortcuts-dialog" aria-labelledby="help-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => event.stopPropagation()}
    onPointerDown={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header>
      <CircleHelp size={20} aria-hidden="true" />
      <h2 id="help-title">{t('help.title')}</h2>
      <button type="button" className="icon-button" aria-label={t('help.close')} data-testid="help-close" onClick={onClose} autoFocus><X size={18} aria-hidden="true" /></button>
    </header>
    <div className="shortcut-groups shortcut-list">
      {columns.map((column, index) => <div key={index} className="shortcut-column">
        {column.map(group => <section key={group.title} className="shortcut-group" aria-labelledby={`help-${group.title}`}>
          <h3 id={`help-${group.title}`}>{t(group.title)}</h3>
          <dl>{group.rows.map(([label, keys]) => <div key={label}><dt>{label}</dt><dd>{keys.map((alternative, i) => <span key={i} className="shortcut-keys">
            {i > 0 && <span aria-hidden="true">/</span>}{alternative.map((key, j) => <kbd key={j}>{key}</kbd>)}</span>)}</dd></div>)}</dl>
        </section>)}
      </div>)}
    </div>
    <details className="help-licence">
      <summary>{t('help.licence')}</summary>
      <p>{t('help.licenceNotice')}</p>
      {/* The browser build hands its code out from the site, so it says where that code's source and its parts' licences
          are (GPL 3, section 6); the desktop installer carries them. */}
      {window.veacom?.web && <p>
        <a href="https://github.com/veacom-viewer/veacom" target="_blank" rel="noopener noreferrer">{t('help.source')}</a>
        <br />{t('help.notices')} <a href="THIRD_PARTY_JAVASCRIPT_LICENSES.md" target="_blank" rel="noopener">JavaScript</a>
        {' · '}<a href="RUST_LICENSES.txt" target="_blank" rel="noopener">Rust</a>
      </p>}
      <pre lang="en" tabIndex={0} aria-label={t('help.licence')}>{licence}</pre>
    </details>
    <footer>
      <span className="help-version">VEAcom {window.veacom?.getVersion() || '2'}</span>
      {onCheckUpdates && <button type="button" className="secondary-button" data-testid="help-check-updates" onClick={onCheckUpdates}>{t('help.checkUpdates')}</button>}
    </footer>
  </dialog>;
}
