import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import TelemetrySetupModal from '../components/TelemetrySetupModal'
import { getState, validatePath, checkNanoclaw, startScan, getFindings, getEstimate, startEstimate, startAgentScan } from '../api'
import type { AppState, EstimateReport, FindingsDocument, NanoclawStatus } from '../types'

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

export default function Home() {
  const navigate = useNavigate()
  const [pathInput, setPathInput] = useState('')
  const [pathValid, setPathValid] = useState<boolean | null>(null)
  const [validating, setValidating] = useState(false)

  const [scanMode, setScanMode] = useState<'static' | 'full'>('static')
  const [nanoclaw, setNanoclaw] = useState<NanoclawStatus | null>(null)
  const [nanoclawLoading, setNanoclawLoading] = useState(false)

  const [state, setState] = useState<AppState | null>(null)
  const [findings, setFindings] = useState<FindingsDocument | null>(null)
  const [estimate, setEstimate] = useState<EstimateReport | null>(null)

  const [rescan, setRescan] = useState(false)
  const [showTelemetryModal, setShowTelemetryModal] = useState(false)
  const [agentScanning, setAgentScanning] = useState(false)

  const [logs, setLogs] = useState<string[]>([])
  const [diagnosisLogs, setDiagnosisLogs] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const diagRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load initial state
  useEffect(() => {
    getState().then(s => {
      setState(s)
      if (s.repoPath) setPathInput(s.repoPath)
      if (s.hasFindings) getFindings().then(setFindings).catch(() => {})
      if (s.hasEstimate) getEstimate().then(setEstimate).catch(() => {})
    }).catch(() => {})
  }, [])

  // Poll while running
  useEffect(() => {
    if (!state) return
    const isRunning = state.scanStatus === 'running' || state.estimateStatus === 'running' || state.diagnosisStatus === 'running' || state.instrumentStatus === 'running'
    if (isRunning) {
      pollRef.current = setInterval(async () => {
        try {
          const s = await getState()
          setState(s)
          if (s.scanStatus === 'done' && s.hasFindings) {
            const f = await getFindings()
            setFindings(f)
            // auto-start estimate
            if (s.estimateStatus === 'idle') {
              await startEstimate()
              setState(await getState())
            }
          }
          if (s.estimateStatus === 'done' && s.hasEstimate) {
            const e = await getEstimate()
            setEstimate(e)
          }
          if (s.scanStatus !== 'running' && s.estimateStatus !== 'running' && s.diagnosisStatus !== 'running' && s.instrumentStatus !== 'running') {
            clearInterval(pollRef.current!)
          }
        } catch {}
      }, 2000)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [state?.scanStatus, state?.estimateStatus])

  // Log SSE while scanning or diagnosing
  useEffect(() => {
    const active = state?.scanStatus === 'running' || state?.diagnosisStatus === 'running' || state?.instrumentStatus === 'running'
    if (active && !esRef.current) {
      const es = new EventSource('/api/logs')
      esRef.current = es
      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as { type?: string; message?: string }
          const line = msg.message ?? e.data
          if (line.startsWith('[diagnosis]')) {
            setDiagnosisLogs(prev => [...prev.slice(-500), line.replace(/^\[diagnosis\] /, '')])
            setTimeout(() => {
              if (diagRef.current) diagRef.current.scrollTop = diagRef.current.scrollHeight
            }, 10)
          } else {
            setLogs(prev => [...prev.slice(-500), line])
            setTimeout(() => {
              if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
            }, 10)
          }
        } catch {
          setLogs(prev => [...prev.slice(-500), e.data])
        }
      }
      es.onerror = () => { es.close(); esRef.current = null }
    }
    if (!active && esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
  }, [state?.scanStatus, state?.diagnosisStatus])

  async function handleValidate() {
    if (!pathInput.trim()) return
    setValidating(true)
    setPathValid(null)
    try {
      const r = await validatePath(pathInput.trim())
      setPathValid(r.valid && r.isDirectory)
    } catch {
      setPathValid(false)
    } finally {
      setValidating(false)
    }
  }

  async function handleCheckNanoclaw() {
    setNanoclawLoading(true)
    try {
      const r = await checkNanoclaw()
      setNanoclaw(r)
    } catch {
      setNanoclaw({ socketExists: false, responding: false, ready: false, socketPath: '' })
    } finally {
      setNanoclawLoading(false)
    }
  }

  async function handleAgentScan() {
    setAgentScanning(true)
    try {
      await startAgentScan()
      // poll state until done
      const poll = setInterval(async () => {
        const s = await getState()
        setState(s)
        if (s.agentScanStatus === 'done' || s.agentScanStatus === 'error') {
          clearInterval(poll)
          setAgentScanning(false)
        }
      }, 1500)
    } catch {
      setAgentScanning(false)
    }
  }

  async function handleStartScan() {
    if (!pathInput.trim()) return
    setLogs([])
    setDiagnosisLogs([])
    setRescan(false)
    setFindings(null)
    setEstimate(null)
    try {
      await startScan(pathInput.trim(), scanMode)
      const s = await getState()
      setState(s)
    } catch (err: unknown) {
      console.error(err)
    }
  }

  const scanDone = state?.scanStatus === 'done' && !!state?.hasFindings
  const showStep3 = state?.scanStatus === 'running'
  const showResults = scanDone && !rescan
  const showStep2 = pathValid === true && !scanDone && !showStep3 || rescan
  const showError = state?.scanStatus === 'error'

  const topSaving = estimate?.savings_opportunities?.[0]

  return (
    <Layout>
      <div className="page">
        <div className="page-header">
          <div className="page-title">AI Cost Diagnostic</div>
          <div className="page-subtitle">Understand and reduce your AI API spending in three steps.</div>
        </div>

        {/* Step indicators */}
        <div className="steps">
          <div className={`step ${showStep2 || showResults ? 'done' : 'active'}`}>
            <div className="step-num">{showStep2 || showResults ? '✓' : '1'}</div>
            Add project
          </div>
          <div className="step-connector" />
          <div className={`step ${showResults ? 'done' : showStep2 ? 'active' : ''}`}>
            <div className="step-num">{showResults ? '✓' : '2'}</div>
            Choose scan
          </div>
          <div className="step-connector" />
          <div className={`step ${showResults ? 'done' : showStep3 ? 'active' : ''}`}>
            <div className="step-num">{showResults ? '✓' : '3'}</div>
            View results
          </div>
        </div>

        {/* Step 1 */}
        {!showResults && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title">Step 1 — Add your project</div>
            <div className="form-group">
              <div className="input-row">
                <input
                  className={`input${pathValid === true ? ' input--valid' : pathValid === false ? ' input--invalid' : ''}`}
                  type="text"
                  placeholder="/Users/you/my-project"
                  value={pathInput}
                  onChange={e => { setPathInput(e.target.value); setPathValid(null) }}
                  onKeyDown={e => e.key === 'Enter' && handleValidate()}
                />
                <button className="btn btn--secondary" onClick={handleValidate} disabled={validating || !pathInput.trim()}>
                  {validating ? <span className="spinner spinner--sm" /> : null}
                  Validate
                </button>
              </div>
              <div className="form-hint">
                {pathValid === true && <span style={{ color: 'var(--green)' }}>✓ Valid project folder</span>}
                {pathValid === false && <span style={{ color: 'var(--red)' }}>✗ Path not found or not a folder</span>}
                {pathValid === null && 'Tip: drag your project folder onto the terminal to get its path, then paste it here.'}
              </div>
            </div>

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 4 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--text-muted)' }}>
                Or — scan all local AI agent sessions
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <button
                  className="btn btn--secondary"
                  onClick={handleAgentScan}
                  disabled={agentScanning || state?.agentScanStatus === 'running'}
                >
                  {agentScanning || state?.agentScanStatus === 'running'
                    ? <><span className="spinner spinner--sm" /> Scanning agent sessions...</>
                    : state?.hasAgentReport
                    ? '↺ Rescan Agent Usage'
                    : 'Scan Agent Usage'}
                </button>
                {state?.hasAgentReport && (
                  <button className="btn btn--primary" onClick={() => navigate('/agent-usage')}>
                    View Agent Usage →
                  </button>
                )}
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Reads ~/.claude/projects — covers Claude Code and Nanoclaw sessions
                </span>
              </div>
              {state?.agentScanStatus === 'error' && (
                <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>
                  ✗ {state.agentScanError ?? 'Agent scan failed'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Step 2 */}
        {showStep2 && !showStep3 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{rescan ? 'Choose a new scan type' : 'Step 2 — Choose scan type'}</span>
              {rescan && (
                <button className="btn btn--ghost btn--sm" onClick={() => setRescan(false)}>
                  Cancel
                </button>
              )}
            </div>
            <div className="option-cards">
              <button
                className={`option-card${scanMode === 'static' ? ' selected' : ''}`}
                onClick={() => setScanMode('static')}
              >
                <div className="option-card-title">
                  Quick Scan
                  <span className="badge badge--green" style={{ fontSize: 11 }}>Recommended</span>
                </div>
                <div className="option-card-desc">
                  Scans your code in seconds using pattern matching. No extra setup required. Best for getting started.
                </div>
              </button>

              <button
                className={`option-card${scanMode === 'full' ? ' selected' : ''}`}
                onClick={() => { setScanMode('full'); if (!nanoclaw) handleCheckNanoclaw() }}
              >
                <div className="option-card-title">Deep Scan</div>
                <div className="option-card-desc">
                  Uses AI to find API calls that pattern matching might miss. Requires Docker and Nanoclaw to be running.
                </div>
                <div className="option-card-status">
                  {scanMode === 'full' && (
                    nanoclawLoading ? (
                      <span className="inline-status"><span className="spinner spinner--sm" /> Checking...</span>
                    ) : nanoclaw ? (
                      nanoclaw.ready ? (
                        <span style={{ color: 'var(--green)', fontSize: 12 }}>✓ Nanoclaw is running</span>
                      ) : !nanoclaw.socketExists ? (
                        <span style={{ color: 'var(--red)', fontSize: 12 }}>✗ Not started — run <code>pnpm run dev</code> in the nanoclaw folder</span>
                      ) : (
                        <span style={{ color: 'var(--red)', fontSize: 12 }}>✗ Socket found but not responding — try restarting Nanoclaw</span>
                      )
                    ) : (
                      <button className="btn btn--ghost btn--sm" onClick={e => { e.stopPropagation(); handleCheckNanoclaw() }}>
                        Check status
                      </button>
                    )
                  )}
                </div>
              </button>
            </div>

            <button
              className="btn btn--primary btn--lg"
              onClick={handleStartScan}
              disabled={scanMode === 'full' && nanoclaw !== null && !nanoclaw.ready}
            >
              Start Scan
            </button>
          </div>
        )}

        {/* Step 3 - Scanning */}
        {showStep3 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span className="spinner" />
              <span style={{ fontWeight: 600 }}>Scanning your project...</span>
            </div>
            <div className="log-viewer" ref={logRef}>
              {logs.length === 0 && <span className="log-line">Starting scanner...</span>}
              {logs.map((line, i) => (
                <div key={i} className={`log-line${line.includes('ERROR') || line.includes('error') ? ' log-line--error' : line.includes('✓') || line.includes('done') || line.includes('Done') ? ' log-line--success' : ' log-line--info'}`}>
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error */}
        {showError && (
          <>
            <div className="banner banner--error">
              <span className="banner-icon">✗</span>
              <div className="banner-body">
                <div className="banner-title">Scan failed</div>
                <div>{state?.scanError ?? 'An unknown error occurred.'}</div>
                <button className="btn btn--secondary btn--sm" style={{ marginTop: 8 }} onClick={() => setState(s => s ? { ...s, scanStatus: 'idle' } : s)}>
                  Try Again
                </button>
              </div>
            </div>

            {(state?.diagnosisStatus !== 'idle' || diagnosisLogs.length > 0) && (
              <div className="card" style={{ marginTop: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  {state?.diagnosisStatus === 'running' && <span className="spinner spinner--sm" />}
                  <span style={{ fontWeight: 600, fontSize: 14 }}>
                    {state?.diagnosisStatus === 'running'
                      ? 'Nanoclaw is diagnosing the error...'
                      : state?.diagnosisStatus === 'done'
                      ? '✓ Nanoclaw diagnosis'
                      : '✗ Diagnosis unavailable'}
                  </span>
                </div>
                {state?.diagnosisStatus === 'error' && state.diagnosisError && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>{state.diagnosisError}</div>
                )}
                {diagnosisLogs.length > 0 && (
                  <div className="log-viewer" ref={diagRef} style={{ maxHeight: 320 }}>
                    {diagnosisLogs.map((line, i) => (
                      <div key={i} className={`log-line${line.includes('✓') ? ' log-line--success' : line.includes('✗') || line.toLowerCase().includes('error') ? ' log-line--error' : ' log-line--info'}`}>
                        {line}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Results */}
        {showResults && (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
              <button className="btn btn--ghost btn--sm" onClick={() => { setRescan(true); setPathValid(true) }}>
                ↩ Change scan type
              </button>
            </div>
            <div className="stat-row">
              <div className="stat-card">
                <div className="stat-label">AI Call Sites Found</div>
                <div className="stat-value">{findings?.summary.total ?? '—'}</div>
                <div className="stat-sub">locations in your code</div>
              </div>

              <div className="stat-card">
                <div className="stat-label">Estimated Monthly Cost</div>
                {state?.estimateStatus === 'running' ? (
                  <div className="stat-value" style={{ fontSize: 18 }}><span className="spinner spinner--sm" /> Calculating...</div>
                ) : estimate ? (
                  <div className="stat-value stat-value--accent">{fmt(estimate.totals.total_usd)}</div>
                ) : (
                  <div className="stat-value">—</div>
                )}
                <div className="stat-sub">per month</div>
              </div>

              <div className="stat-card">
                <div className="stat-label">Potential Savings</div>
                {topSaving ? (
                  <div className="stat-value stat-value--green">{fmt(topSaving.savings_usd)}</div>
                ) : state?.estimateStatus === 'running' ? (
                  <div className="stat-value" style={{ fontSize: 18 }}><span className="spinner spinner--sm" /></div>
                ) : (
                  <div className="stat-value">—</div>
                )}
                <div className="stat-sub">{topSaving ? `${topSaving.savings_percent.toFixed(0)}% by switching models` : 'per month'}</div>
              </div>

              <div className="stat-card">
                <div className="stat-label">Telemetry</div>
                {state?.hasEvents ? (
                  <div className="stat-value" style={{ fontSize: 16 }}>
                    <span className="badge badge--green">Active</span>
                  </div>
                ) : (
                  <div className="stat-value" style={{ fontSize: 16 }}>
                    <span className="badge badge--gray">Not set up</span>
                  </div>
                )}
                <div className="stat-sub">real usage data</div>
              </div>
            </div>

            <div className="btn-row" style={{ marginBottom: 16 }}>
              <button className="btn btn--primary" onClick={() => navigate('/sources')}>
                View AI Call Sites →
              </button>
              {state?.hasEvents && (
                <button className="btn btn--secondary" onClick={() => navigate('/analyze')}>
                  Analyze Inputs →
                </button>
              )}
              {state?.hasAgentReport && (
                <button className="btn btn--secondary" onClick={() => navigate('/agent-usage')}>
                  View Agent Usage →
                </button>
              )}
            </div>

            {!state?.hasEvents && (
              <div className="info-box" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                <div>
                  <strong>Want deeper savings analysis?</strong> Set up telemetry to capture real token usage from your app. This lets us analyze actual inputs and recommend the cheapest model for each call.
                </div>
                <button
                  className="btn btn--primary btn--sm"
                  style={{ flexShrink: 0 }}
                  onClick={() => setShowTelemetryModal(true)}
                >
                  Set Up Telemetry
                </button>
              </div>
            )}
          </>
        )}
      </div>
      {showTelemetryModal && findings && (
        <TelemetrySetupModal
          findings={findings.findings}
          initialInstrumentStatus={state?.instrumentStatus}
          initialExpiresAt={state?.telemetryExpiresAt}
          initialRemoveAt={state?.telemetryRemoveAt}
          onClose={() => setShowTelemetryModal(false)}
        />
      )}
    </Layout>
  )
}
