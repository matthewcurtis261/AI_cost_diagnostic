import { Link, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { getState } from '../api'
import type { AppState } from '../types'

interface Props {
  children: React.ReactNode
}

export default function Layout({ children }: Props) {
  const location = useLocation()
  const [state, setState] = useState<AppState | null>(null)

  useEffect(() => {
    getState().then(setState).catch(() => {})
  }, [location.pathname])

  const canSources = state?.hasFindings ?? false
  const canAnalyze = state?.hasEvents ?? false

  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          </div>
          <div className="sidebar-logo-text">AI Cost<br/>Diagnostic</div>
        </div>

        <div className="sidebar-nav">
          <Link
            to="/"
            className={`nav-item${location.pathname === '/' ? ' active' : ''}`}
          >
            <span className="nav-icon">🏠</span>
            Home
          </Link>

          {canSources ? (
            <Link
              to="/sources"
              className={`nav-item${location.pathname.startsWith('/sources') ? ' active' : ''}`}
            >
              <span className="nav-icon">📍</span>
              AI Call Sites
            </Link>
          ) : (
            <span className="nav-item nav-item--disabled">
              <span className="nav-icon">📍</span>
              AI Call Sites
            </span>
          )}

          {canAnalyze ? (
            <Link
              to="/analyze"
              className={`nav-item${location.pathname === '/analyze' ? ' active' : ''}`}
            >
              <span className="nav-icon">🔬</span>
              Analyze Inputs
            </Link>
          ) : (
            <span className="nav-item nav-item--disabled">
              <span className="nav-icon">🔬</span>
              Analyze Inputs
            </span>
          )}
        </div>

        {state?.repoPath && (
          <div className="sidebar-footer">
            <div className="sidebar-footer-label">Project</div>
            <div className="sidebar-footer-path">{state.repoPath.split('/').slice(-2).join('/')}</div>
          </div>
        )}
      </nav>

      <main className="main-content">
        {children}
      </main>
    </div>
  )
}
