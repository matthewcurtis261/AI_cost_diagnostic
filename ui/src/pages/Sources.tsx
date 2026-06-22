import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import { ProviderBadge, ConfidenceBadge, CallTypeBadge } from '../components/Badge'
import { getFindings, getEstimate, getState } from '../api'
import type { FindingsDocument, EstimateReport } from '../types'

function fmt(n: number) {
  if (n < 0.01) return '<$0.01'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

function shortPath(p: string) {
  const parts = p.split('/')
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p
}

export default function Sources() {
  const navigate = useNavigate()
  const [findings, setFindings] = useState<FindingsDocument | null>(null)
  const [estimate, setEstimate] = useState<EstimateReport | null>(null)
  const [estimateRunning, setEstimateRunning] = useState(false)
  const [loading, setLoading] = useState(true)
  const refreshRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function load() {
    try {
      const [f, s] = await Promise.all([getFindings(), getState()])
      setFindings(f)
      setEstimateRunning(s.estimateStatus === 'running')
      if (s.hasEstimate) {
        const e = await getEstimate()
        setEstimate(e)
      }
    } catch {}
    setLoading(false)
  }

  useEffect(() => {
    load()
    refreshRef.current = setInterval(load, 30000)
    return () => { if (refreshRef.current) clearInterval(refreshRef.current) }
  }, [])

  if (loading) {
    return (
      <Layout>
        <div className="page">
          <div className="empty-state">
            <span className="spinner spinner--lg" style={{ margin: '0 auto 16px', display: 'block' }} />
            <div>Loading...</div>
          </div>
        </div>
      </Layout>
    )
  }

  if (!findings || findings.findings.length === 0) {
    return (
      <Layout>
        <div className="page">
          <div className="empty-state">
            <span className="empty-state-icon">📭</span>
            <div className="empty-state-title">No AI call sites found yet</div>
            <div className="empty-state-desc">Run a scan from the home page to discover where your app calls AI providers.</div>
            <button className="btn btn--primary" style={{ marginTop: 20 }} onClick={() => navigate('/')}>
              Go to Home
            </button>
          </div>
        </div>
      </Layout>
    )
  }

  const costMap: Record<string, number> = {}
  estimate?.line_items.forEach(li => {
    costMap[li.finding_id] = li.cost.total_usd
  })

  const totalCost = estimate?.totals.total_usd
  const totalCalls = estimate?.totals.calls
  const dataSource = estimate?.estimate_metadata.mode === 'telemetry' ? 'Telemetry' : 'Estimated'

  return (
    <Layout>
      <div className="page">
        <div className="page-header">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="page-title">AI Call Sites</div>
              <div className="page-subtitle">{findings.findings.length} locations where your app calls an AI provider</div>
            </div>
            <button className="btn btn--secondary" onClick={() => navigate('/')}>Re-scan</button>
          </div>
        </div>

        {estimateRunning && (
          <div className="banner banner--warning">
            <span className="banner-icon"><span className="spinner spinner--sm" /></span>
            <div className="banner-body">
              <span>Running cost estimate... this may take a moment.</span>
            </div>
          </div>
        )}

        {estimate && (
          <div className="summary-bar">
            <div className="summary-bar-item">
              <div className="summary-bar-label">Monthly Cost</div>
              <div className="summary-bar-value">{totalCost !== undefined ? totalCost.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '—'}</div>
            </div>
            <div className="summary-bar-item">
              <div className="summary-bar-label">Monthly Calls</div>
              <div className="summary-bar-value">{totalCalls?.toLocaleString() ?? '—'}</div>
            </div>
            <div className="summary-bar-item">
              <div className="summary-bar-label">Data Source</div>
              <div className="summary-bar-value">
                <span className={`badge ${dataSource === 'Telemetry' ? 'badge--green' : 'badge--yellow'}`}>{dataSource}</span>
              </div>
            </div>
          </div>
        )}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Line</th>
                <th>Provider</th>
                <th>Type</th>
                <th>Confidence</th>
                <th>Monthly Cost</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {findings.findings.map(f => (
                <tr key={f.id}>
                  <td>
                    <span className="td-mono td-trunc" title={f.location.file}>
                      {shortPath(f.location.file)}
                    </span>
                  </td>
                  <td className="td-mono">{f.location.lines[0]}</td>
                  <td>
                    <ProviderBadge provider={f.provider} />
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{f.model}</div>
                  </td>
                  <td><CallTypeBadge callType={f.call_type} /></td>
                  <td><ConfidenceBadge confidence={f.confidence} /></td>
                  <td>
                    {costMap[f.id] !== undefined
                      ? <strong>{fmt(costMap[f.id])}</strong>
                      : estimateRunning
                      ? <span className="spinner spinner--sm" />
                      : <span style={{ color: 'var(--text-muted)' }}>—</span>
                    }
                  </td>
                  <td>
                    <Link to={`/sources/${f.id}`} className="btn btn--ghost btn--sm">Details →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  )
}
