import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('dashboard-root');
if (!container) {
  throw new Error('dashboard-root element not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
