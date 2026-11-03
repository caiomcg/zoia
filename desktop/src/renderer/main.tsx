import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from './i18n';
import './styles.css';
import { installCrashReporting } from './crash-reporting';

async function start() {
  const preview = import.meta.env.DEV && new URLSearchParams(location.search).has('demo');
  if (preview) {
    const { installDemo } = await import('./demo');
    installDemo();
  }
  const { default: App } = await import('./App');
  installCrashReporting();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider>
        <App preview={preview} />
      </I18nProvider>
    </StrictMode>,
  );
}

void start();
