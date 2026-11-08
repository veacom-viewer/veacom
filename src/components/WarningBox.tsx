import type { ReactNode } from 'react';
import { X } from './icons';
import { useTranslation } from '../i18n/react';
import { dismiss, useDismissed } from '../ui/dismissed';

/** A box of warnings or cautions in a panel: its title, its lines, and a dismiss button at its top right
 * (docs/design-guidelines.md). Dismissed, it stays hidden for this session until what it says changes: `dismissKey`
 * names the box and what it says. The marks beside the values it explains stay. */
export function WarningBox({ title, dismissKey, id, testId, className, children }: { title: string; dismissKey: string; id?: string; testId?: string; className?: string; children: ReactNode }) {
  const { t } = useTranslation();
  const dismissed = useDismissed(dismissKey);
  if (dismissed) return null;
  return <div className={className ? `geometry-warnings ${className}` : 'geometry-warnings'} role="note" id={id} data-testid={testId} data-warning-box>
    <div className="warning-box-head"><strong>{title}</strong>
      <button type="button" className="warning-box-dismiss" data-action="warning-dismiss" aria-label={t('warning.dismiss')} data-tooltip={t('warning.dismiss')}
        onClick={event => {
          // Focus stays in the panel the box leaves.
          const panel = event.currentTarget.closest<HTMLElement>('[role="tabpanel"]');
          dismiss(dismissKey);
          panel?.focus();
        }}><X size={14} /></button></div>
    {children}
  </div>;
}
