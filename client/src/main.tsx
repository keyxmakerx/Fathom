import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { Hints } from './components/shell/Hints'
import { applyStoredTheme } from './theme'

// The stored Light or Dark choice, on the page before the first draw.
applyStoredTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* One hint card for the whole page: any control marked with `hint(...)` explains itself. */}
    <Hints />
  </StrictMode>,
)
