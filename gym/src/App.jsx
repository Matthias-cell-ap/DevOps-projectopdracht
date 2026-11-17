import { useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useAppStore } from './store/useAppStore.js'
import Dashboard from './pages/Dashboard.jsx'
import DailyLog from './pages/DailyLog.jsx'
import Exercises from './pages/Exercises.jsx'
import Schedule from './pages/Schedule.jsx'
import Research from './pages/Research.jsx'
import Data from './pages/Data.jsx'
import Settings from './pages/Settings.jsx'

export default function App() {
  const loadProfile = useAppStore(s => s.loadProfile)

  useEffect(() => {
    loadProfile()
  }, [loadProfile])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"           element={<Dashboard />} />
        <Route path="/log"        element={<DailyLog />} />
        <Route path="/exercises"  element={<Exercises />} />
        <Route path="/schedule"   element={<Schedule />} />
        <Route path="/research"   element={<Research />} />
        <Route path="/data"       element={<Data />} />
        <Route path="/settings"   element={<Settings />} />
      </Routes>
    </BrowserRouter>
  )
}
