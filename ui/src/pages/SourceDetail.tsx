import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Layout from '../components/Layout'
import { ProviderBadge, ConfidenceBadge, CallTypeBadge } from '../components/Badge'
import { getFindings, getEstimate, getAnalysis, getState, startAnalyze } from '../api'
import type { Finding, EstimateLineItem, InputAnalysisItem, AppState, QualityPreset } from '../types'

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

export default function SourceDetail() {
  const { id } = useParams<{ id: string }>()
  const [finding, setFinding] = useState<Finding | null>(null)
  const [lineItem, setLineItem] = useState<EstimateLineItem | null>(null)
  const [analysisItems, setAnalysisItems] = useState<InputAnalysisItem[]>([])
  const [appState, setAppState] = useState<AppState | null>(null)
  const [loading, setLoading] = useState(true)
  const [preset, setPreset] = useState<QualityPreset>('balanced')
  const [analyzing, setAnalyzing] = useState(false)
  const [savingsOpp, setSavingsOpp] = useState<{ alternative_model: string; savings_usd: number; savings_percent: number } | null>(null)

  async function load() {
    try {
      const [s, fd] = await Promise.all([getState(), getFindings()])
      setAppState(s)
      const found = fd.findings.find(f => f.id === id) ?? null
      setFinding(found)

      if (s.hasEstimate) {
        try {
          const est = await getEstimate()
          const li = est.line_items.find(l => l.finding_id === id) ?? null
          setLineItem(li)
          const opp = est.savings_opportunities?.find(o => o.finding_id === id)
          if (opp) setSavingsOpp({ alternative_model: opp.alternative_model, savings_usd: opp.savings_usd, savings_percent: opp.savings_percent })
        } catch {}
      }

      if (s.hasAnalysis) {
        try {
          const an = await getAnalysis()
          const items = an.items.filter(i => i.finding_id === id)
          setAnalysisItems(items)
          if (an.analysis_metadata.quality_preset) {
            setPreset(an.analysis_metadata.quality_preset)
          }
        } catch {}
      }
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [id])

  async function handleRunAnalysis() {
    setAnalyzing(true)
    try {
      await startAnalyze(preset)
      // poll until done
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const s = await getState()
        if (s.analyzeStatus === 'done') {
          await load()
          break
        }
        if (s.analyzeStatus === 'error') break
      }
    } catch {}
    setAnalyzing(false)
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

  if (!finding) {
    return (
      <Layout>
        <div className="page">
          <Link to="/sources" className="back-link">← All AI Call Sites</Link>
          <div className="empty-state">
            <div className="empty-state-title">Call site not found</div>
          </div>
        </div>
      </Layout>
    )
  }

  const itemsWithRec = analysisItems.filter(i => i.recommendation?.passes_quality_floor)
  const totalSavings = itemsWithRec.reduce((s, i) => s + (i.recommendation?.savings_usd ?? 0), 0)

  return (
    <Layout>
      <div className="page">
        <Link to="/sources" className="back-link">← All AI Call Sites</Link>

        <div className="page-header">
          <div className="page-title" style={{ fontFamily: 'var(--mono)', fontSize: 16, wordBreak: 'break-all' }}>
            {finding.location.file}
            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> :{finding.location.lines[0]}</span>
          </div>
        </div>

        {/* Info card */}
        <div className="card">
          <div className="card-title">Call Details</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 16, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Provider</div>
              <ProviderBadge provider={finding.provider} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Model</div>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{finding.model}</span>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Type</div>
              <CallTypeBadge callType={finding.call_type} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Confidence</div>
              <ConfidenceBadge confidence={finding.confidence} />
            </div>
          </div>

          {finding.evidence && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 500 }}>Code Evidence</div>
              <div className="code-block">{finding.evidence}</div>
            </div>
          )}

          {finding.notes && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, fontWeight: 500 }}>Notes</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{finding.notes}</div>
            </div>
          )}
        </div>

        {/* Usage & Cost card */}
        <div className="card">
          <div className="card-title">Usage & Cost</div>
          {lineItem ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 16, marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Monthly Calls</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{lineItem.usage.calls.toLocaleString()}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Input Tokens</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{lineItem.usage.input_tokens.toLocaleString()}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Output Tokens</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{lineItem.usage.output_tokens.toLocaleString()}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Monthly Cost</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent)' }}>{fmt(lineItem.cost.total_usd)}</div>
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <span className={`badge ${lineItem.usage.source === 'telemetry' ? 'badge--green' : lineItem.usage.source === 'mixed' ? 'badge--blue' : 'badge--yellow'}`}>
                  {lineItem.usage.source === 'telemetry' ? 'Telemetry data' : lineItem.usage.source === 'mixed' ? 'Mixed data' : 'Estimated'}
                </span>
              </div>

              {savingsOpp && (
                <div className="savings-highlight">
                  <span>💡</span>
                  <span>
                    Switch to <strong>{savingsOpp.alternative_model}</strong> to save{' '}
                    <strong>{fmt(savingsOpp.savings_usd)}/mo</strong> ({savingsOpp.savings_percent.toFixed(0)}% less)
                  </span>
                </div>
              )}
            </>
          ) : appState?.estimateStatus === 'running' ? (
            <div className="inline-status"><span className="spinner spinner--sm" /> Running cost estimate...</div>
          ) : (
            <div className="info-box">Run estimate from the home page to see cost details for this call site.</div>
          )}
        </div>

        {/* Input Analysis card */}
        {appState?.hasEvents && (
          <div className="card">
            <div className="card-title">Input-Aware Analysis</div>

            {appState.hasAnalysis && analysisItems.length > 0 ? (
              <>
                <div className="tabs" style={{ marginBottom: 16 }}>
                  {(['conservative', 'balanced', 'aggressive'] as QualityPreset[]).map(p => (
                    <button
                      key={p}
                      className={`tab${preset === p ? ' active' : ''}`}
                      onClick={() => { setPreset(p); }}
                    >
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </button>
                  ))}
                  <button
                    className="btn btn--secondary btn--sm"
                    style={{ marginLeft: 'auto', alignSelf: 'center' }}
                    onClick={handleRunAnalysis}
                    disabled={analyzing}
                  >
                    {analyzing ? <><span className="spinner spinner--sm" /> Analyzing...</> : 'Re-run'}
                  </button>
                </div>

                <div className="table-wrap" style={{ marginBottom: 12 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Current Model</th>
                        <th>Recommended</th>
                        <th>Savings</th>
                        <th>Quality</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysisItems.slice(0, 20).map(item => (
                        <tr key={item.event_id}>
                          <td className="td-mono">{new Date(item.timestamp).toLocaleTimeString()}</td>
                          <td className="td-mono" style={{ fontSize: 12 }}>{item.model}</td>
                          <td className="td-mono" style={{ fontSize: 12 }}>
                            {item.recommendation ? item.recommendation.alternative_model : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                          </td>
                          <td>
                            {item.recommendation
                              ? <span style={{ color: 'var(--green)', fontWeight: 600 }}>{fmt(item.recommendation.savings_usd)}</span>
                              : <span style={{ color: 'var(--text-muted)' }}>{item.skipped_reason ?? '—'}</span>}
                          </td>
                          <td style={{ fontSize: 12 }}>
                            {item.recommendation?.quality_delta !== null && item.recommendation?.quality_delta !== undefined
                              ? `${(item.recommendation.quality_delta * 100).toFixed(1)}%`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {itemsWithRec.length > 0 && (
                  <div className="savings-highlight">
                    <span>💡</span>
                    <span>
                      <strong>{((itemsWithRec.length / analysisItems.length) * 100).toFixed(0)}%</strong> of calls could use a cheaper model,
                      saving <strong>{fmt(totalSavings)}/mo</strong>
                    </span>
                  </div>
                )}
              </>
            ) : appState.hasAnalysis ? (
              <div className="info-box">No analysis data for this call site.</div>
            ) : (
              <div>
                <div className="info-box" style={{ marginBottom: 12 }}>
                  Click "Analyze Inputs" to see per-call recommendations based on real token usage.
                </div>
                <button className="btn btn--primary" onClick={handleRunAnalysis} disabled={analyzing}>
                  {analyzing ? <><span className="spinner spinner--sm spinner--white" /> Analyzing...</> : 'Analyze Inputs'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Layout>
  )
}
