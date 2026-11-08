import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { t } from './i18n';
import './fonts.css';
import './theme.css';
import './styles.css';

class ApplicationBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  override render() {
    if (this.state.error) return <main className="fatal-error"><h1>{t('fatal.title')}</h1><p>{this.state.error}</p><button onClick={() => location.reload()}>{t('fatal.reopen')}</button></main>;
    return this.props.children;
  }
}
// The desktop window has no title bar; the toolbar makes room for the window controls (styles.css). A browser tab
// (the browser build's bridge, src/web) has its own.
if (window.veacom && !window.veacom.web) {
  document.documentElement.dataset.titlebar = 'toolbar';
}
createRoot(document.getElementById('root')!).render(<ApplicationBoundary><App /></ApplicationBoundary>);
