import { useEffect, useRef, useState } from 'react';
import { Check, Download, ExternalLink, LoaderCircle, RefreshCw, RotateCw, X } from './icons';
import type { UpdateStatus } from '../model';
import { errorMessage, type MessageKey, type Translator } from '../i18n';
import { useTranslation } from '../i18n/react';
import { usage } from '../usage/tracker';
import './UpdateDialog.css';

export interface UpdateDialogProps { onClose: () => void; }
type Action = 'check' | 'download' | 'install' | 'notes';

const phaseLabel: Record<UpdateStatus['phase'], MessageKey> = {
  manual: 'update.phase.manual', idle: 'update.phase.idle', checking: 'update.phase.checking', 'up-to-date': 'update.phase.upToDate',
  unavailable: 'update.phase.unavailable', available: 'update.phase.available', downloading: 'update.phase.downloading',
  ready: 'update.phase.ready', installing: 'update.phase.installing', error: 'update.phase.error',
};

function requestError(failure: unknown, t: Translator) {
  return failure instanceof Error ? errorMessage(failure) : t('update.requestFailed');
}

export function UpdateDialog({ onClose }: UpdateDialogProps) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const live = useRef(false);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { usage.touch('dialog'); }, [status, action, error]);
  const bridge = window.veacom;

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    live.current = true;
    let active = true;
    let receivedEvent = false;
    const unsubscribe = bridge?.onUpdateStatus(value => {
      receivedEvent = true;
      if (active) setStatus(value);
    });
    if (bridge) void bridge.getUpdateStatus().then(value => {
      if (active && !receivedEvent) setStatus(value);
    }).catch(failure => { if (active) setError(failure instanceof Error ? errorMessage(failure) : t('update.statusUnreadable')); });
    return () => { active = false; live.current = false; unsubscribe?.(); element?.close(); };
  }, [bridge]);

  async function run(next: Action) {
    if (!bridge || action) return;
    setAction(next); setError('');
    const request = () => next === 'notes' ? bridge.openUpdateNotes() : next === 'check' ? bridge.checkForUpdates()
      : next === 'download' ? bridge.downloadUpdate() : bridge.installUpdate();
    let status: UpdateStatus | void = undefined;
    try { status = await request(); }
    catch (failure) { if (live.current) setError(requestError(failure, t)); }
    if (live.current) {
      if (status) setStatus(status);
      setAction(null);
    }
  }

  const working = Boolean(action && action !== 'notes') || ['checking', 'downloading', 'installing'].includes(status?.phase ?? '');
  const percent = status?.progress === undefined || !Number.isFinite(status.progress) ? undefined : Math.min(100, Math.max(0, status.progress));
  const title = status ? t(phaseLabel[status.phase]) : bridge ? t('update.readingStatus') : t('update.desktopRequired');
  const showInstall = status?.phase === 'ready' || Boolean(status?.canInstall);
  const showDownload = !showInstall && Boolean(status?.version && (status.canDownload || status.sourceBuild || status.phase === 'downloading'));

  return <dialog ref={dialog} className="update-dialog" aria-labelledby="update-dialog-title" aria-describedby="update-dialog-message"
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><RefreshCw size={17} /><h2 id="update-dialog-title">{t('update.title')}</h2><button type="button" className="update-close" aria-label={t('update.close')} data-testid="update-close" onClick={onClose} autoFocus><X size={17} /></button></header>
    <div className="update-content">
      <dl className="update-versions"><div><dt>{t('update.installed')}</dt><dd>{status?.currentVersion || bridge?.getVersion() || t('update.unknownVersion')}</dd></div>
        {status?.version && <div><dt>{t('update.available')}</dt><dd>{status.version}</dd></div>}</dl>
      <div className={`update-status${status?.phase === 'error' ? ' has-error' : ''}`} role="status" aria-live="polite">
        {working ? <LoaderCircle size={16} className="update-spinner" /> : status?.phase === 'up-to-date' ? <Check size={16} /> : <Download size={16} />}
        <div><strong>{title}</strong><p id="update-dialog-message">{status?.message || (bridge ? t('update.serviceNote') : t('update.openDesktop'))}</p></div>
      </div>
      {status?.phase === 'downloading' && <div className="update-progress"><progress aria-label={t('update.progress')} max={100} value={percent} /><span>{percent === undefined ? t('update.downloading') : `${Math.round(percent)}%`}</span></div>}
      {status?.sourceBuild && status.phase !== 'manual' && <p className="update-source-note">{t('update.sourceNote')}</p>}
      {status?.phase === 'ready' && !status.sourceBuild && <p className="update-source-note">{t('update.readyNote')}</p>}
      {status?.releaseNotes && <details className="update-notes"><summary>{t('update.releaseNotes')}</summary><p>{status.releaseNotes}</p></details>}
      {error && <p className="update-error" role="alert">{error}</p>}
    </div>
    <footer>
      {(status?.version || status?.phase === 'manual') && <button type="button" className="update-notes-link" data-action="update-notes" disabled={Boolean(action)} onClick={() => void run('notes')}><ExternalLink size={13} />{t('update.releasePage')}</button>}
      {status?.phase !== 'manual' && <button type="button" className="update-button" data-action="update-check" disabled={!bridge || working || Boolean(action)} onClick={() => void run('check')}><RefreshCw size={13} />{status?.phase === 'checking' || action === 'check' ? t('update.checking') : t('update.check')}</button>}
      {showDownload && <button type="button" className="update-button primary" data-action="update-download" disabled={!status?.canDownload || status.sourceBuild || working || Boolean(action)} onClick={() => void run('download')}><Download size={13} />{t('update.download')}</button>}
      {showInstall && <button type="button" className="update-button primary" data-action="update-install" disabled={!status?.canInstall || status.sourceBuild || working || Boolean(action)} onClick={() => void run('install')}><RotateCw size={13} />{t('update.openInstaller')}</button>}
    </footer>
  </dialog>;
}
