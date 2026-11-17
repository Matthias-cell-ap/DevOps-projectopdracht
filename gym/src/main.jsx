import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { hydrateDrafts } from './lib/drafts.js'
import './index.css'

// Restore unsaved drafts from durable storage before the first render,
// so every form finds them synchronously when it mounts.
hydrateDrafts().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})
