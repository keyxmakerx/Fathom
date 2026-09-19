import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../../index.css';
import { applyTheme, getStoredTheme } from '../../theme';
import { PortGallery } from './PortGallery';

// Entry for `client/ports.html` — a static page, no session, no server.
applyTheme(getStoredTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PortGallery />
  </StrictMode>,
);
