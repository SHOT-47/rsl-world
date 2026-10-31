import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { browserWorkbench } from './browser-workbench'
import './styles.css'

// Install a deliberately limited adapter when running in a normal browser.
if (typeof window !== 'undefined' && !window.workbench) {
  window.workbench = browserWorkbench
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
)
