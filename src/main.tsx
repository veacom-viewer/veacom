import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { exceptionClass } from '../electron/crash-exception.mjs';
import { t } from './i18n';
import './fonts.css';
import './theme.css';
import './styles.css';

class ApplicationBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    try {
      const message = error && Object.getOwnPropertyDescriptor(error, 'message')?.value;
      return { error: typeof message === 'string' ? message : '' };
    } catch {
      return { error: '' };
    }
  }
  override componentDidCatch(error: unknown) {
    const bridge = window.veacom;
    if (bridge && !bridge.web) bridge.reportRendererFailure?.('render-failed', exceptionClass(error));
  }
  override render() {
    if (this.state.error !== null) return <main className="fatal-error"><h1>{t('fatal.title')}</h1><p>{this.state.error}</p><button onClick={() => location.reload()}>{t('fatal.reopen')}</button></main>;
    return this.props.children;
  }
}
// The desktop window has no title bar; the toolbar makes room for the window controls (styles.css). A browser tab
// (the browser build's bridge, src/web) has its own.
if (window.veacom && !window.veacom.web) {
  document.documentElement.dataset.titlebar = 'toolbar';
  const report = window.veacom.reportRendererFailure;
  if (report) {
    window.addEventListener('error', event => {
      if (event.isTrusted && event.target === window && event instanceof ErrorEvent) report('uncaught-exception', exceptionClass(event.error));
    });
    window.addEventListener('unhandledrejection', event => {
      if (event.isTrusted && event.target === window) report('unhandled-rejection', exceptionClass(event.reason));
    });
  }
}
createRoot(document.getElementById('root')!).render(<ApplicationBoundary><App /></ApplicationBoundary>);
