import { useEffect, useEffectEvent, useRef } from 'react';
import { subscribeEngineState } from './api';
import { t } from './i18n';
import type { CoreState } from './model';

interface RecoveryCallbacks {
  setConnectionError: (message: string | null) => void;
  setNotice: (notice: { message: string; kind: 'info' | 'error'; code?: string }) => void;
  onInterrupted: () => void;
}

export function useEngineRecovery(callbacks: RecoveryCallbacks): void {
  const interrupted = useRef(false);
  const onState = useEffectEvent((state: CoreState) => {
    if (state.status === 'ready') {
      interrupted.current = false;
      callbacks.setConnectionError(null);
      if (state.restartCount > 0) callbacks.setNotice({ message: state.message || t('engine.restarted'), kind: 'info', code: 'engine-restarted' });
    } else if (state.status === 'restarting' || state.status === 'failed') {
      if (!interrupted.current) callbacks.onInterrupted();
      interrupted.current = true;
      const message = state.message || t('engine.stopped');
      callbacks.setConnectionError(message);
      callbacks.setNotice({ message, kind: 'error', code: `engine-${state.status}` });
    }
  });
  useEffect(() => subscribeEngineState(state => onState(state)), []);
}
