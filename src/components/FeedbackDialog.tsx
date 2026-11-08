import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, MessageSquare, X } from './icons';
import { useTranslation } from '../i18n/react';
import './FeedbackDialog.css';

type Kind = 'problem' | 'suggestion';
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;

/**
 * A problem report or a suggestion. Main shows the exact text in its own dialog and sends it only when the
 * user confirms there (electron/feedback.cjs). Usage data records nothing from here (`data-usage-ignore`),
 * so a message can't be matched to an install's usage history by its time.
 */
export function FeedbackDialog({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const messageField = useRef<HTMLTextAreaElement>(null);
  const live = useRef(false);
  const [kind, setKind] = useState<Kind>('problem');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [includeSystem, setIncludeSystem] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const bridge = window.veacom;
  useEffect(() => {
    const element = dialog.current;
    // Focus after showModal: the dialog would otherwise move focus to its first button.
    element?.showModal(); live.current = true; messageField.current?.focus();
    return () => { live.current = false; element?.close(); };
  }, []);

  const emailValid = !email.trim() || EMAIL.test(email.trim());
  const ready = Boolean(bridge?.sendFeedback) && message.trim().length > 0 && emailValid && !sending;
  async function send() {
    if (!ready || !bridge?.sendFeedback) return;
    setSending(true); setError('');
    await bridge.sendFeedback({ kind, message, email: email.trim(), includeSystem }).then(result => {
      if (!live.current) return;
      if (result.ok) { onSent(); onClose(); return; }
      // Cancelled in main's confirmation, or one already open there: the form stays as it was.
      if (result.cancelled || result.reason === 'busy') return;
      setError(result.status === 429 ? t('feedback.tooMany') : result.status === 400 && result.reason === 'email' ? t('feedback.invalidEmail')
        : result.reason === 'off' ? t('feedback.off') : t('feedback.failed'));
    }).catch(() => {
      if (live.current) setError(t('feedback.failed'));
    }).finally(() => { if (live.current) setSending(false); });
  }

  // onClose also covers a second Escape, which the browser lets close the dialog even while sending.
  return <dialog ref={dialog} className="feedback-dialog" aria-labelledby="feedback-dialog-title" data-usage-ignore
    onCancel={event => { event.preventDefault(); if (!sending) onClose(); }} onClose={onClose} onKeyDown={event => event.stopPropagation()}>
    <header><MessageSquare size={17} /><h2 id="feedback-dialog-title">{t('feedback.title')}</h2>
      <button type="button" className="feedback-close" aria-label={t('feedback.close')} data-testid="feedback-close" disabled={sending} onClick={onClose}><X size={17} /></button></header>
    <form className="feedback-content" onSubmit={event => { event.preventDefault(); void send(); }}>
      <div className="feedback-kinds" role="radiogroup" aria-label={t('feedback.kind')}>
        {(['problem', 'suggestion'] as const).map(value => <label key={value} className="feedback-kind">
          <input type="radio" name="feedback-kind" data-action="feedback-kind" checked={kind === value} onChange={() => setKind(value)} />
          <span>{t(value === 'problem' ? 'feedback.problem' : 'feedback.suggestion')}</span></label>)}
      </div>
      <p id="feedback-privacy" className="feedback-privacy">{t('feedback.privacy')}</p>
      <label className="feedback-field"><span>{t('feedback.message')}</span>
        <textarea ref={messageField} data-action="feedback-message" value={message} maxLength={5000} rows={6} aria-describedby="feedback-privacy" onChange={event => setMessage(event.target.value)} /></label>
      <label className="feedback-field"><span>{t('feedback.email')}</span>
        <input type="email" data-action="feedback-email" value={email} maxLength={254} autoComplete="email" aria-invalid={!emailValid || undefined} onChange={event => setEmail(event.target.value)} />
        <small>{emailValid ? t('feedback.emailHint') : t('feedback.invalidEmail')}</small></label>
      <label className="feedback-check"><input type="checkbox" data-action="feedback-system" checked={includeSystem} onChange={event => setIncludeSystem(event.target.checked)} /><span>{t('feedback.includeSystem')}</span></label>
      {error && <p className="feedback-error" role="alert">{error}</p>}
      <footer>
        <button type="button" className="secondary-button" data-action="feedback-cancel" disabled={sending} onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" className="primary-button" data-testid="feedback-send" disabled={!ready}>{sending && <LoaderCircle size={14} className="spin" />}{sending ? t('feedback.sending') : t('feedback.send')}</button>
      </footer>
    </form>
  </dialog>;
}

export default FeedbackDialog;
