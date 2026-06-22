import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import { getAnalysis, getState, startAnalyze, getFindings } from '../api'
import type { AnalyzeInputsReport, AppState, FindingsDocument, QualityPreset } from '../types'

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function fmtPrecise(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

function shortPath(p: string) {
  const parts = p.split('/')
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p
}

export default function AnalyzeInputs() {
  const navigate = useNavigate()
  const [appState, setAppState] = useState<AppState | null>(null)
  const [analysis, setAnalysis] = useState<AnalyzeInputsReport | null>(null)
  const [findings, setFindings] = useState<FindingsDocument | null>(null)
  const [preset, setPreset] = useState<QualityPreset>('balanced')
  const [running, setRunning] = useState(false)
  const [loading, setLoading] = useState(true)
  const refreshRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function load() {
    try {
      const s = await getState()
      setAppState(s)
      if (s.hasAnalysis) {
        const a = await getAnalysis()
        setAnalysis(a)
        if (a.analysis_metadata.quality_preset) setPreset(a.analysis_metadata.quality_preset)
      }
      if (s.hasFindings) {
        const f = await getFindings()
        setFindings(f)
      }
    } catch {}
    setLoading(false)
  }

  useEffect(() => {
    load()
    refreshRef.current = setInterval(load, 30000)
    return () => { if (refreshRef.current) clearInterval(refreshRef.current) }
  }, [])

  async function handleRunAnalysis() {
    setRunning(true)
    try {
      await startAnalyze(preset)
      const s = await getState()
      setAppState(s)

      pollRef.current = setInterval(async () => {
        try {
          const s2 = await getState()
          setAppState(s2)
          if (s2.analyzeStatus === 'done') {
            clearInterval(pollRef.current!)
            const a = await getAnalysis()
            setAnalysis(a)
            setRunning(false)
          } else if (s2.analyzeStatus === 'error') {
            clearInterval(pollRef.current!)
            setRunning(false)
          }
        } catch {}
      }, 2000)
    } catch {
      setRunning(false)
    }
  }

  if (loading) {
    return (
      <Layout>
        <div className="page">
          <div className="empty-state">
            <span className="spinner spinner--lg" style={{ margin: '0 auto 16px', display: 'block' }} />
          </div>
        </div>
      </Layout>
    )
  }

  if (!appState?.hasEvents) {
    return (
      <Layout>
        <div className="page">
          <div className="empty-state">
            <span className="empty-state-icon">📡</span>
            <div className="empty-state-title">Telemetry not set up</div>
            <div className="empty-state-desc">
              Input analysis requires real usage data from your app. Set up telemetry to capture actual token usage.
            </div>
            <button className="btn btn--secondary" style={{ marginTop: 20 }} onClick={() => navigate('/')}>
              Go to Home
            </button>
          </div>
        </div>
      </Layout>
    )
  }

  // Compute by-finding breakdown
  const findingMap: Record<string, string> = {}
  findings?.findings.forEach(f => {
    findingMap[f.id] = f.location.file + ':' + f.location.lines[0]
  })

  const byFinding: Record<string, { items: AnalyzeInputsReport['items']; currentUsd: number; savingsUsd: number }> = {}
  analysis?.items.forEach(item => {
    const fid = item.finding_id ?? 'unknown'
    if (!byFinding[fid]) byFinding[fid] = { items: [], currentUsd: 0, savingsUsd: 0 }
    byFinding[fid].items.push(item)
    byFinding[fid].currentUsd += item.current_cost_usd
    byFinding[fid].savingsUsd += item.recommendation?.savings_usd ?? 0
  })

  const altModels = analysis?.summary.by_alternative_model ?? {}
  const maxSavings = Math.max(...Object.values(altModels).map(v => v.savings_usd), 1)

  return (
    <Layout>
      <div className="page">
        <div className="page-header">
          <div className="page-title">Input-Aware Savings Analysis</div>
          <div className="page-subtitle">
            We analyze the actual inputs to each AI call and recommend the cheapest model that maintains your quality requirements.
          </div>
        </div>

        {/* Preset selector */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">Quality Requirement</div>
          <div className="preset-cards">
            <div
              className={`preset-card${preset === 'conservative' ? ' selected' : ''}`}
              onClick={() => setPreset('conservative')}
            >
              <div className="preset-card-title">Conservative</div>
              <div className="preset-card-desc">Maintains 95%+ of current quality. Smallest savings, highest confidence.</div>
            </div>
            <div
              className={`preset-card${preset === 'balanced' ? ' selected' : ''}`}
              onClick={() => setPreset('balanced')}
            >
              <div className="preset-card-title">Balanced</div>
              <div className="preset-card-desc">Maintains 90%+ of current quality. Good balance of savings and reliability.</div>
            </div>
            <div
              className={`preset-card${preset === 'aggressive' ? ' selected' : ''}`}
              onClick={() => setPreset('aggressive')}
            >
              <div className="preset-card-title">Aggressive</div>
              <div className="preset-card-desc">Maintains 85%+ of current quality. Maximum savings, some quality tradeoff.</div>
            </div>
          </div>

          <button
            className="btn btn--primary"
            onClick={handleRunAnalysis}
            disabled={running}
          >
            {running ? <><span className="spinner spinner--sm spinner--white" /> Analyzing...</> : 'Run Analysis'}
          </button>
        </div>

        {/* Results */}
        {analysis && (
          <>
            {/* Summary stats */}
            <div className="stat-row">
              <div className="stat-card">
                <div className="stat-label">Events Analyzed</div>
                <div className="stat-value">{analysis.summary.events_analyzed.toLocaleString()}</div>
                <div className="stat-sub">of {analysis.summary.events_total.toLocaleString()} total</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Current Monthly Cost</div>
                <div className="stat-value">{fmt(analysis.summary.total_current_usd)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Potential Savings</div>
                <div className="stat-value stat-value--green">{fmt(analysis.summary.total_potential_savings_usd)}</div>
                <div className="stat-sub">per month</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">With Recommendations</div>
                <div className="stat-value stat-value--accent">
                  {analysis.summary.events_total > 0
                    ? `${((analysis.summary.events_with_recommendations / analysis.summary.events_total) * 100).toFixed(0)}%`
                    : '0%'}
                </div>
                <div className="stat-sub">of calls can switch models</div>
              </div>
            </div>

            {/* By model recommendations */}
            {Object.keys(altModels).length > 0 && (
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-title">Recommended Alternative Models</div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Alternative Model</th>
                        <th>Events</th>
                        <th>Monthly Savings</th>
                        <th style={{ width: 160 }}>Relative Savings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(altModels)
                        .sort((a, b) => b[1].savings_usd - a[1].savings_usd)
                        .map(([model, data]) => (
                          <tr key={model}>
                            <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{model}</td>
                            <td>{data.count.toLocaleString()}</td>
                            <td><strong style={{ color: 'var(--green)' }}>{fmtPrecise(data.savings_usd)}</strong></td>
                            <td>
                              <div className="progress-bar-wrap">
                                <div
                                  className="progress-bar-fill progress-bar-fill--green"
                                  style={{ width: `${(data.savings_usd / maxSavings) * 100}%` }}
                                />
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Per-finding breakdown */}
            {Object.keys(byFinding).length > 0 && (
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-title">By Call Site</div>
                {Object.entries(byFinding).map(([fid, data]) => {
                  const withRec = data.items.filter(i => i.recommendation?.passes_quality_floor).length
                  const model = data.items[0]?.model ?? 'Unknown'
                  return (
                    <div key={fid} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16, marginBottom: 16 }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                        <div>
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, marginBottom: 3 }}>
                            {findingMap[fid] ? shortPath(findingMap[fid]) : fid}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                            {model} &middot; {data.items.length} events
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontWeight: 700, color: 'var(--green)', fontSize: 15 }}>
                            {fmtPrecise(data.savingsUsd)}/mo savings
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {withRec} of {data.items.length} calls ({data.items.length > 0 ? ((withRec / data.items.length) * 100).toFixed(0) : 0}%) can switch
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Coverage notes */}
            {analysis.coverage_notes.length > 0 && (
              <div className="info-box">
                <strong>Coverage notes:</strong>
                <ul style={{ marginTop: 6, paddingLeft: 18 }}>
                  {analysis.coverage_notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}
          </>
        )}

        {!analysis && !running && (
          <div className="info-box">
            Choose a quality preset above and click "Run Analysis" to see which AI calls could use a cheaper model.
          </div>
        )}

        {running && (
          <div className="banner banner--info">
            <span className="banner-icon"><span className="spinner spinner--sm" /></span>
            <div className="banner-body">Analyzing your inputs... this may take a minute.</div>
          </div>
        )}
      </div>
    </Layout>
  )
}
