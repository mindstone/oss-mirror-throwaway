// web-companion/src/main.tsx

import { initAuthStore } from '@rebel/cloud-client';
import { webTokenStorage } from './storage/webTokenStorage';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './theme/globals.css';

// Init auth BEFORE rendering — singleton must exist before any component calls useAuthStore()
initAuthStore(webTokenStorage);

const rootElement = document.getElementById('root');
if (!rootElement) {
  // Fail fast: #root is part of index.html. If it's missing, something's
  // seriously wrong with the bundle and a silent empty render would hide it.
  throw new Error('web-companion: #root element not found in document');
}
createRoot(rootElement).render(<App />);
