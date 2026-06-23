import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import { getAgentReport, startAgentDeepScan, getAgentDeepReport } from '../api'
import type { AgentReport, AgentTrendBucket, AgentDeepReport, AgentSessionReport } from '../types'

const RESCAN_INTERVAL_MS = 5 * 60 * 1000

function fmtUsd(n: number) {
  if (n < 0.01) return '<$0.01'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString()
}

// ── Trend chart ───────────────────────────────────────────────────────────────

function TrendChart({ data, metric }: { data: AgentTrendBucket[]; metric: 'costUsd' | 'inputTokens' | 'outputTokens' }) {
  if (data.length === 0) return <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '16px 0' }}>No trend data yet.</div>

  const W = 600, H = 160, PAD = { top: 12, right: 16, bottom: 32, left: 56 }
  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top - PAD.bottom

  const values = data.map(d => d[metric] as number)
  const maxVal = Math.max(...values, 0.001)

  // fill in missing days
  const allDates: string[] = []
  if (data.length > 1) {
    const start = new Date(data[0].date)
    const end = new Date(data[data.length - 1].date)
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      allDates.push(d.toISOString().slice(0, 10))
    }
  } else {
    allDates.push(data[0].date)
  }

  const byDate: Record<string, number> = {}
  for (const d of data) byDate[d.date] = d[metric] as number

  const points = allDates.map((date, i) => {
    const v = byDate[date] ?? 0
    const x = PAD.left + (allDates.length <= 1 ? chartW / 2 : (i / (allDates.length - 1)) * chartW)
    const y = PAD.top + chartH - (v / maxVal) * chartH
    return { x, y, v, date }
  })

  const polyline = points.map(p => `${p.x},${p.y}`).join(' ')

  // y-axis labels
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(pct => {
    const val = pct * maxVal
    const y = PAD.top + chartH - pct * chartH
    const label = metric === 'costUsd' ? fmtUsd(val) : fmtTokens(val)
    return { y, label }
  })

  // x-axis: show ~5 date labels
  const xTickIndices = allDates.length <= 5
    ? allDates.map((_, i) => i)
    : [0, Math.floor(allDates.length * 0.25), Math.floor(allDates.length * 0.5), Math.floor(allDates.length * 0.75), allDates.length - 1]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, display: 'block' }}>
      {/* grid lines */}
      {yTicks.map((t, i) => (
        <line key={i} x1={PAD.left} y1={t.y} x2={W - PAD.right} y2={t.y}
          stroke="var(--border)" strokeWidth="1" strokeDasharray="3,3" />
      ))}
      {/* y-axis labels */}
      {yTicks.map((t, i) => (
        <text key={i} x={PAD.left - 6} y={t.y + 4} textAnchor="end"
          fontSize="10" fill="var(--text-muted)">{t.label}</text>
      ))}
      {/* area fill */}
      <polygon
        points={`${points[0].x},${PAD.top + chartH} ${polyline} ${points[points.length - 1].x},${PAD.top + chartH}`}
        fill="var(--accent)" opacity="0.12"
      />
      {/* line */}
      <polyline points={polyline} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
      {/* dots */}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3" fill="var(--accent)" />
      ))}
      {/* x-axis labels */}
      {xTickIndices.map(i => (
        <text key={i} x={points[i].x} y={H - 4} textAnchor="middle"
          fontSize="10" fill="var(--text-muted)">
          {allDates[i].slice(5)} {/* MM-DD */}
        </text>
      ))}
    </svg>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

const TIER_COLORS: Record<string, string> = {
  haiku:  'var(--green)',
  sonnet: 'var(--accent)',
  opus:   '#a855f7',
}

function MetricBadge({ metric }: { metric: string | null }) {
  if (!metric) return <span className="badge badge--gray">unclassified</span>
  return <span className="badge badge--gray" style={{ textTransform: 'capitalize', fontFamily: 'monospace', fontSize: 11 }}>{metric.replace(/_/g, ' ')}</span>
}

function TierBadge({ tier }: { tier: string }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: TIER_COLORS[tier] + '22', color: TIER_COLORS[tier], border: `1px solid ${TIER_COLORS[tier]}44`, textTransform: 'capitalize' }}>
      {tier}
    </span>
  )
}

function SessionsTable({ sessions }: { sessions: AgentSessionReport[] }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const shown = sessions.slice(0, 50)

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
          <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>Project</th>
          <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>Model</th>
          <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>Task type</th>
          <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>Recommended</th>
          <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 500 }}>Cost</th>
          <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 500 }}>Savings</th>
          <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 500 }}>Messages</th>
        </tr>
      </thead>
      <tbody>
        {shown.map(s => {
          const label = s.project_path.split('/').filter(Boolean).slice(-2).join('/')
          const isOpen = expanded === s.session_id
          return (
            <>
              <tr key={s.session_id}
                style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                onClick={() => setExpanded(isOpen ? null : s.session_id)}>
                <td style={{ padding: '7px 8px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.project_path}>
                  <span style={{ marginRight: 4, opacity: 0.5 }}>{isOpen ? '▾' : '▸'}</span>{label}
                </td>
                <td style={{ padding: '7px 8px', fontFamily: 'monospace', fontSize: 11, whiteSpace: 'nowrap' }}>{s.primary_model}</td>
                <td style={{ padding: '7px 8px' }}><MetricBadge metric={s.classification.primary_metric} /></td>
                <td style={{ padding: '7px 8px', fontFamily: 'monospace', fontSize: 11 }}>
                  {s.recommendation?.kind === 'downgrade'
                    ? <span style={{ color: 'var(--green)' }}>{s.recommendation.alternative_model}</span>
                    : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                </td>
                <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600 }}>{fmtUsd(s.cost_usd)}</td>
                <td style={{ padding: '7px 8px', textAlign: 'right' }}>
                  {s.recommendation
                    ? s.recommendation.kind === 'downgrade'
                      ? <span style={{ color: 'var(--green)' }}>↓ save {s.recommendation.savings_pct.toFixed(1)}% ({fmtUsd(s.recommendation.savings_usd)})</span>
                      : <span style={{ color: 'var(--yellow, #f59e0b)' }}>↑ consider upgrade</span>
                    : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                </td>
                <td style={{ padding: '7px 8px', textAlign: 'right', color: 'var(--text-muted)' }}>{s.message_count}</td>
              </tr>
              {isOpen && (
                <tr key={`${s.session_id}-detail`} style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                  <td colSpan={7} style={{ padding: '10px 16px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 12 }}>
                      <div>
                        <div style={{ color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600 }}>Classification</div>
                        <div>Metrics: {s.classification.metric_ids.length > 0 ? s.classification.metric_ids.join(', ') : 'none'}</div>
                        <div>Runtime: {s.classification.classifier_runtime}</div>
                        {s.recommendation && s.recommendation.kind === 'downgrade' && (
                          <div style={{ marginTop: 6, color: 'var(--green)' }}>
                            → Switch to <strong>{s.recommendation.alternative_model}</strong> and save {s.recommendation.savings_pct}% ({fmtUsd(s.recommendation.savings_usd)} on this session)
                          </div>
                        )}
                        {s.recommendation && s.recommendation.kind === 'upgrade' && (
                          <div style={{ marginTop: 6, color: 'var(--yellow, #f59e0b)' }}>
                            ↑ Consider upgrading to <strong>{s.recommendation.alternative_model}</strong> for better results on this task type ({fmtUsd(Math.abs(s.recommendation.cost_delta_usd))} more)
                          </div>
                        )}
                      </div>
                      <div>
                        <div style={{ color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600 }}>Reconstruction notes</div>
                        <div>{s.reconstruction.turnCount} human turns · {s.reconstruction.toolCallCount} tool calls</div>
                        {s.reconstruction.toolNames.length > 0 && (
                          <div style={{ fontFamily: 'monospace', fontSize: 11, marginTop: 2 }}>Tools: {s.reconstruction.toolNames.join(', ')}</div>
                        )}
                        {s.reconstruction.likelyPruned && (
                          <div style={{ color: 'var(--yellow, #f59e0b)', marginTop: 4 }}>⚠ Long session — context pruning likely affected classification</div>
                        )}
                        {s.reconstruction.missingFileContents && (
                          <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>File contents referenced but not captured</div>
                        )}
                        <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>System prompt not captured (always missing)</div>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </>
          )
        })}
      </tbody>
    </table>
  )
}

export default function AgentUsage() {
  const navigate = useNavigate()
  const [report, setReport] = useState<AgentReport | null>(null)
  const [deepReport, setDeepReport] = useState<AgentDeepReport | null>(null)
  const [deepScanning, setDeepScanning] = useState(false)
  const [deepScanError, setDeepScanError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [countdown, setCountdown] = useState(RESCAN_INTERVAL_MS / 1000)
  const [trendMetric, setTrendMetric] = useState<'costUsd' | 'inputTokens' | 'outputTokens'>('costUsd')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const countRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function refresh() {
    try {
      const r = await getAgentReport()
      setReport(r)
      setLastRefreshed(new Date())
    } catch {
      // report not available yet
    } finally {
      setLoading(false)
    }
    try {
      const dr = await getAgentDeepReport()
      setDeepReport(dr)
    } catch {
      // deep report optional
    }
  }

  async function handleDeepScan() {
    setDeepScanning(true)
    setDeepScanError(null)
    try {
      await startAgentDeepScan()
      // Poll until done
      const poll = setInterval(async () => {
        try {
          const dr = await getAgentDeepReport()
          setDeepReport(dr)
          setDeepScanning(false)
          clearInterval(poll)
        } catch {
          // still running
        }
      }, 3000)
      // Timeout after 3 minutes
      setTimeout(() => {
        clearInterval(poll)
        if (deepScanning) {
          setDeepScanning(false)
          setDeepScanError('Deep scan timed out — check server logs')
        }
      }, 3 * 60 * 1000)
    } catch (err) {
      setDeepScanning(false)
      setDeepScanError(String(err))
    }
  }

  useEffect(() => {
    refresh()

    timerRef.current = setInterval(() => {
      refresh()
      setCountdown(RESCAN_INTERVAL_MS / 1000)
    }, RESCAN_INTERVAL_MS)

    countRef.current = setInterval(() => {
      setCountdown(c => Math.max(0, c - 1))
    }, 1000)

    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (countRef.current) clearInterval(countRef.current)
    }
  }, [])

  if (loading) return (
    <Layout>
      <div className="page">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 40 }}>
          <span className="spinner" />
          <span>Loading agent usage data...</span>
        </div>
      </div>
    </Layout>
  )

  if (!report) return (
    <Layout>
      <div className="page">
        <div className="page-header">
          <button className="btn btn--ghost btn--sm" onClick={() => navigate('/')} style={{ marginBottom: 12 }}>← Back</button>
          <div className="page-title">Agent Usage</div>
        </div>
        <div className="banner banner--error">
          <span className="banner-icon">✗</span>
          <div className="banner-body">
            <div className="banner-title">No agent report found</div>
            <div>Go back and click "Scan Agent Usage" to run the first scan.</div>
          </div>
        </div>
      </div>
    </Layout>
  )

  const { totals, by_project, by_model, by_tool, trend, potential_savings } = report
  const savings = potential_savings.if_downgrade_to_haiku

  // sort projects by cost desc
  const projects = Object.entries(by_project).sort(([, a], [, b]) => b.costUsd - a.costUsd)
  const models = Object.entries(by_model).sort(([, a], [, b]) => b.costUsd - a.costUsd)

  return (
    <Layout>
      <div className="page">
        <div className="page-header">
          <button className="btn btn--ghost btn--sm" onClick={() => navigate('/')} style={{ marginBottom: 12 }}>← Back</button>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div className="page-title">Agent Usage</div>
              <div className="page-subtitle">Token consumption and cost across all local AI sessions.</div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'right' }}>
              <div>Last scanned: {lastRefreshed ? fmtDate(lastRefreshed.toISOString()) : fmtDate(report.scanned_at)}</div>
              <div>Next refresh in {countdown}s</div>
            </div>
          </div>
        </div>

        {/* ── Totals ── */}
        <div className="stat-row">
          <div className="stat-card">
            <div className="stat-label">Total Cost (all time)</div>
            <div className="stat-value stat-value--accent">{fmtUsd(totals.costUsd)}</div>
            <div className="stat-sub">{totals.sessions} sessions</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Input Tokens</div>
            <div className="stat-value">{fmtTokens(totals.inputTokens)}</div>
            <div className="stat-sub">+{fmtTokens(totals.cacheReadTokens)} cache reads</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Output Tokens</div>
            <div className="stat-value">{fmtTokens(totals.outputTokens)}</div>
            <div className="stat-sub">{totals.messages} messages total</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Potential Savings</div>
            <div className="stat-value stat-value--green">{fmtUsd(savings.savingsUsd)}</div>
            <div className="stat-sub">{savings.savingsPct}% if all runs used Haiku</div>
          </div>
        </div>

        {/* ── By tool ── */}
        {Object.keys(by_tool).length > 1 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title">By Tool</div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {Object.entries(by_tool).map(([tool, v]) => (
                <div key={tool} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>{tool}</span>
                  <span className="badge badge--gray">{v.sessions} sessions</span>
                  <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{fmtUsd(v.costUsd)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Trend chart ── */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Usage Trend (last 90 days)</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['costUsd', 'inputTokens', 'outputTokens'] as const).map(m => (
                <button key={m} className={`btn btn--ghost btn--sm${trendMetric === m ? ' selected' : ''}`}
                  style={trendMetric === m ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : {}}
                  onClick={() => setTrendMetric(m)}>
                  {m === 'costUsd' ? 'Cost' : m === 'inputTokens' ? 'Input' : 'Output'}
                </button>
              ))}
            </div>
          </div>
          <TrendChart data={trend} metric={trendMetric} />
        </div>

        {/* ── By project ── */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">By Project</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>Project</th>
                <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>Tool</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 500 }}>Sessions</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 500 }}>Input</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 500 }}>Output</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 500 }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {projects.map(([path, p]) => (
                <tr key={path} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={path}>{p.label}</td>
                  <td style={{ padding: '8px' }}>
                    <span className={`badge ${p.tool === 'nanoclaw' ? 'badge--green' : 'badge--gray'}`}>{p.tool}</span>
                  </td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{p.sessions}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{fmtTokens(p.inputTokens)}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{fmtTokens(p.outputTokens)}</td>
                  <td style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }}>{fmtUsd(p.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── By model ── */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">By Model</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>Model</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 500 }}>Sessions</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 500 }}>Input</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 500 }}>Output</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 500 }}>Cost</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 500 }}>% of total</th>
              </tr>
            </thead>
            <tbody>
              {models.map(([model, m]) => (
                <tr key={model} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: 12 }}>{model}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{m.sessions}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{fmtTokens(m.inputTokens)}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{fmtTokens(m.outputTokens)}</td>
                  <td style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }}>{fmtUsd(m.costUsd)}</td>
                  <td style={{ padding: '8px', textAlign: 'right', color: 'var(--text-muted)' }}>
                    {totals.costUsd > 0 ? `${Math.round(m.costUsd / totals.costUsd * 100)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Savings recommendation ── */}
        {savings.savingsPct >= 10 && (
          <div className="info-box" style={{ marginBottom: 16 }}>
            <strong>Cost optimization opportunity:</strong> {savings.savingsPct}% of your total spend ({fmtUsd(savings.savingsUsd)}) could be saved if all sessions ran on claude-haiku. Review the model breakdown above to identify which projects are using heavyweight models for tasks that don't require them.
          </div>
        )}

        {/* ── Deep scan ── */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Task Classification (Deep Scan)</span>
            <button
              className="btn btn--primary btn--sm"
              onClick={handleDeepScan}
              disabled={deepScanning}
            >
              {deepScanning ? <><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Scanning...</> : deepReport ? '↺ Re-classify' : 'Run Deep Scan'}
            </button>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
            Reconstructs each session's task from conversation history and tool calls, then classifies it to recommend the best-fit model. Costs shown above use exact token counts; recommendations here are based on task type.
          </div>

          {deepScanError && (
            <div className="banner banner--error" style={{ marginBottom: 12 }}>
              <span className="banner-icon">✗</span>
              <div className="banner-body">{deepScanError}</div>
            </div>
          )}

          {!deepReport && !deepScanning && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0' }}>
              No classification data yet. Run a deep scan to classify your sessions by task type and get model recommendations.
            </div>
          )}

          {deepReport && (
            <>
              {/* Deep scan totals */}
              {(() => {
                const upgrades = deepReport.sessions.filter(s => s.recommendation?.kind === 'upgrade').length
                const downgrades = deepReport.sessions.filter(s => s.recommendation?.kind === 'downgrade').length
                return (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
                <div style={{ padding: '10px 16px', background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)', minWidth: 120 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>Sessions classified</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{deepReport.totals.sessions}</div>
                </div>
                {downgrades > 0 && (
                <div style={{ padding: '10px 16px', background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)', minWidth: 120 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>Downgrade savings</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--green)' }}>{fmtUsd(deepReport.totals.savingsUsd)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{deepReport.totals.savingsPct}% · {downgrades} session{downgrades !== 1 ? 's' : ''}</div>
                </div>
                )}
                {upgrades > 0 && (
                <div style={{ padding: '10px 16px', background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)', minWidth: 140 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>Possible under-tier</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--yellow, #f59e0b)' }}>{upgrades} session{upgrades !== 1 ? 's' : ''}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>task complexity may exceed model</div>
                </div>
                )}
                <div style={{ padding: '10px 16px', background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)', minWidth: 160 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>By task type</div>
                  {Object.entries(deepReport.by_metric).sort(([,a],[,b]) => b.costUsd - a.costUsd).slice(0, 4).map(([metric, v]) => (
                    <div key={metric} style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <span style={{ textTransform: 'capitalize' }}>{metric.replace(/_/g, ' ')}</span>
                      <span style={{ color: 'var(--text-muted)' }}>{v.sessions} sessions</span>
                    </div>
                  ))}
                </div>
                {Object.keys(deepReport.by_recommendation).length > 0 && (
                  <div style={{ padding: '10px 16px', background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)', minWidth: 160 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Recommended alternatives</div>
                    {Object.entries(deepReport.by_recommendation).sort(([,a],[,b]) => b.savingsUsd - a.savingsUsd).map(([model, v]) => (
                      <div key={model} style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{model}</span>
                        <span style={{ color: 'var(--green)' }}>{fmtUsd(v.savingsUsd)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
                )
              })()}

              {/* Reconstruction coverage note */}
              {deepReport.reconstruction_coverage.sessions_likely_pruned > 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, padding: '6px 10px', background: 'var(--bg)', borderRadius: 6, borderLeft: '3px solid var(--border)' }}>
                  {deepReport.reconstruction_coverage.sessions_likely_pruned} session(s) were long enough that context pruning likely occurred — classifications for those may be less accurate. System prompt is missing from all reconstructions.
                </div>
              )}

              {/* Sessions table */}
              <SessionsTable sessions={deepReport.sessions} />
            </>
          )}
        </div>
      </div>
    </Layout>
  )
}
