import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './styles.css';
import './phase5.css';
import './proto.css';
import './persist/persist.css';
import { App } from './App';
import { connectEngine } from './store';
import { initPersistence } from './persist/actions';

const root = document.getElementById('root');
if (!root) throw new Error('#root fehlt');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
void connectEngine().then(initPersistence);
