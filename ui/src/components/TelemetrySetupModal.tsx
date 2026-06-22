import { useEffect, useRef, useState } from 'react'
import type { Finding } from '../types'
import { startInstrumentation } from '../api'

interface Props {
  findings: Finding[]
  initialInstrumentStatus?: string
  initialExpiresAt?: string | null
  initialRemoveAt?: string | null
  onClose: () => void
}

type Lang = 'ts' | 'py'

function detectLang(file: string): Lang {
  return file.endsWith('.py') ? 'py' : 'ts'
}

function installCmd(langs: Set<Lang>): string[] {
  const cmds: string[] = []
  if (langs.has('py')) cmds.push('pip install -e ./telemetry/python')
  if (langs.has('ts')) cmds.push('# TypeScript — diagnostic-agent/telemetry is already in this repo')
  return cmds
}

function wrapperSnippet(finding: Finding, lang: Lang): string {
  const id = finding.id
  const provider = finding.provider.toLowerCase()

  if (lang === 'py') {
    if (provider === 'anthropic') {
      return [
        'from anthropic import Anthropic',
        'from diagnostic_agent_telemetry import instrument_anthropic',
        '',
        `client = instrument_anthropic(Anthropic(), finding_id="${id}")`,
      ].join('\n')
    }
    return [
      'from openai import OpenAI',
      'from diagnostic_agent_telemetry import instrument_openai',
      '',
      `client = OpenAI()`,
      `instrument_openai(client, finding_id="${id}")`,
    ].join('\n')
  }

  if (provider === 'anthropic') {
    return [
      `import Anthropic from '@anthropic-ai/sdk'`,
      `import { instrumentAnthropic } from 'diagnostic-agent/telemetry'`,
      '',
      `const client = instrumentAnthropic(new Anthropic(), { findingId: '${id}' })`,
    ].join('\n')
  }
  return [
    `import OpenAI from 'openai'`,
    `import { instrumentOpenAI } from 'diagnostic-agent/telemetry'`,
    '',
    `const client = instrumentOpenAI(new OpenAI(), { findingId: '${id}' })`,
  ].join('\n')
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }
  return (
    <button className="btn btn--ghost btn--sm" style={{ fontSize: 11, padding: '2px 8px' }} onClick={handleCopy}>
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  )
}

type InstrumentPhase = 'idle' | 'confirming' | 'running' | 'done' | 'error'

const DURATION_OPTIONS = [
  { label: '6 hours',  hours: 6 },
  { label: '12 hours', hours: 12 },
  { label: '24 hours', hours: 24 },
  { label: '48 hours', hours: 48 },
  { label: '72 hours', hours: 72 },
]

function formatTimeRemaining(isoString: string): string {
  const diff = new Date(isoString).getTime() - Date.now()
  if (diff <= 0) return 'any moment now'
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export default function TelemetrySetupModal({ findings, initialInstrumentStatus, initialExpiresAt, initialRemoveAt, onClose }: Props) {
  const relevant = findings.filter(f => f.confidence !== 'low')
  const langs = new Set(relevant.map(f => detectLang(f.location.file))) as Set<Lang>
  const installCmds = installCmd(langs)

  const [phase, setPhase] = useState<InstrumentPhase>(
    initialInstrumentStatus === 'running' ? 'running' :
    initialInstrumentStatus === 'done'    ? 'done'    : 'idle'
  )
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [timeLimited, setTimeLimited] = useState(false)
  const [durationHours, setDurationHours] = useState(24)
  const [removeFromCode, setRemoveFromCode] = useState(false)
  const [expiresAt, setExpiresAt] = useState<string | null>(initialExpiresAt ?? null)
  const [removeAt, setRemoveAt] = useState<string | null>(initialRemoveAt ?? null)
  const [, setTick] = useState(0) // forces re-render for countdown
  const logRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

  // Tick every 30s to refresh the countdown display
  useEffect(() => {
    if (!expiresAt && !removeAt) return
    const t = setInterval(() => setTick(n => n + 1), 30_000)
    return () => clearInterval(t)
  }, [expiresAt, removeAt])

  // Open SSE while running
  useEffect(() => {
    if (phase !== 'running') return

    const es = new EventSource('/api/logs')
    esRef.current = es
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { message?: string }
        const line = msg.message ?? e.data
        if (line.startsWith('[instrument]')) {
          const clean = line.replace(/^\[instrument\] /, '')
          setLogs(prev => [...prev.slice(-500), clean])
          setTimeout(() => {
            if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
          }, 10)
        }
      } catch { /* ignore non-JSON */ }
    }
    es.onerror = () => { es.close(); esRef.current = null }

    return () => { es.close(); esRef.current = null }
  }, [phase])

  async function handleConfirm() {
    setPhase('running')
    setLogs([])
    setError(null)
    try {
      await startInstrumentation(timeLimited ? { durationHours, removeFromCode } : undefined)
      if (timeLimited) {
        const at = new Date(Date.now() + durationHours * 3_600_000).toISOString()
        setExpiresAt(at)
        if (removeFromCode) setRemoveAt(at)
      }
    } catch (err) {
      setPhase('error')
      setError(err instanceof Error ? err.message : 'Failed to start instrumentation')
    }
  }

  // Poll for completion when running, and sync expiry times from server state
  useEffect(() => {
    if (phase !== 'running') return
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/state')
        const s = await res.json() as {
          instrumentStatus?: string
          instrumentError?: string
          telemetryExpiresAt?: string | null
          telemetryRemoveAt?: string | null
        }
        if (s.telemetryExpiresAt) setExpiresAt(s.telemetryExpiresAt)
        if (s.telemetryRemoveAt) setRemoveAt(s.telemetryRemoveAt)
        if (s.instrumentStatus === 'done') { setPhase('done'); clearInterval(timer) }
        if (s.instrumentStatus === 'error') {
          setPhase('error')
          setError(s.instrumentError ?? 'Unknown error')
          clearInterval(timer)
        }
      } catch { /* ignore */ }
    }, 2000)
    return () => clearInterval(timer)
  }, [phase])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">Set Up Telemetry</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
            Captures real token usage per call site for more accurate cost estimates.
          </div>
          <button className="btn btn--ghost btn--sm modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">

          {/* Auto-instrument banner */}
          {relevant.length > 0 && phase === 'idle' && (
            <div className="auto-instrument-banner">
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>
                  Let Nanoclaw do it automatically
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  Nanoclaw will install the wrapper package and add it to all {relevant.length} call {relevant.length === 1 ? 'site' : 'sites'} in one go — no manual edits needed.
                </div>
              </div>
              <button className="btn btn--primary btn--sm" style={{ flexShrink: 0 }} onClick={() => setPhase('confirming')}>
                Auto-instrument
              </button>
            </div>
          )}

          {/* Confirmation dialog */}
          {phase === 'confirming' && (
            <div className="confirm-dialog">
              <div style={{ fontSize: 16, marginBottom: 8 }}>⚠️ Write access warning</div>
              <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 12, lineHeight: 1.6 }}>
                This will give <strong>Nanoclaw write access to your repository</strong>. It will modify source files to add telemetry wrapper imports and wrap your AI client instantiations.
              </p>
              <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 16, lineHeight: 1.6 }}>
                Only <strong>{relevant.length} file{relevant.length !== 1 ? 's' : ''}</strong> will be changed — no other code will be touched. We recommend committing or stashing any uncommitted changes before proceeding so you can easily review or revert the diff.
              </p>

              {/* Time-limit options */}
              <div style={{ borderTop: '1px solid #fde68a', paddingTop: 12, marginBottom: 16 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 500, marginBottom: 8 }}>
                  <input type="checkbox" checked={timeLimited} onChange={e => setTimeLimited(e.target.checked)} />
                  Auto-disable telemetry after
                  <select
                    className="duration-select"
                    value={durationHours}
                    disabled={!timeLimited}
                    onChange={e => setDurationHours(Number(e.target.value))}
                  >
                    {DURATION_OPTIONS.map(o => (
                      <option key={o.hours} value={o.hours}>{o.label}</option>
                    ))}
                  </select>
                </label>
                {timeLimited && (
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)', paddingLeft: 22 }}>
                    <input
                      type="checkbox"
                      checked={removeFromCode}
                      onChange={e => setRemoveFromCode(e.target.checked)}
                      style={{ marginTop: 2, flexShrink: 0 }}
                    />
                    <span>
                      Also remove wrapper code from source files
                      <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>
                        Requires Nanoclaw to be running at expiry. Without this, only the env var is set — code stays but writes are silenced.
                      </span>
                    </span>
                  </label>
                )}
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn btn--secondary btn--sm" onClick={() => setPhase('idle')}>
                  Cancel
                </button>
                <button className="btn btn--primary btn--sm" onClick={handleConfirm}>
                  Yes, instrument my code
                </button>
              </div>
            </div>
          )}

          {/* Running / done / error */}
          {(phase === 'running' || phase === 'done' || phase === 'error') && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                {phase === 'running' && <span className="spinner spinner--sm" />}
                <span style={{ fontWeight: 600, fontSize: 14 }}>
                  {phase === 'running' ? 'Nanoclaw is instrumenting your code...' :
                   phase === 'done'    ? '✓ Instrumentation complete' :
                                        '✗ Instrumentation failed'}
                </span>
                {phase !== 'running' && (
                  <button className="btn btn--ghost btn--sm" style={{ marginLeft: 'auto' }} onClick={() => { setPhase('idle'); setLogs([]) }}>
                    Reset
                  </button>
                )}
              </div>
              {phase === 'error' && error && (
                <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{error}</div>
              )}
              {phase === 'done' && (
                <div className="banner banner--success" style={{ marginBottom: 12 }}>
                  <span className="banner-icon">✓</span>
                  <div className="banner-body">
                    Wrappers added. Run your app and events will start appearing in{' '}
                    <code>~/.diagnostic_agent/events.jsonl</code>. Then click <strong>Analyze Inputs</strong> on the home screen.
                    {expiresAt && (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={{ fontSize: 12 }}>
                          🕐 Telemetry auto-disables in <strong>{formatTimeRemaining(expiresAt)}</strong>
                          {' '}— <code>DIAGNOSTIC_AGENT_TELEMETRY=0</code> will be written to your <code>.env</code>
                        </span>
                        {removeAt && (
                          <span style={{ fontSize: 12 }}>
                            🗑 Wrapper code removed from source files at the same time
                            {' '}(requires Nanoclaw to be running)
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {logs.length > 0 && (
                <div className="log-viewer" ref={logRef} style={{ height: 220 }}>
                  {logs.map((line, i) => (
                    <div key={i} className={`log-line${line.includes('✓') ? ' log-line--success' : line.includes('✗') || line.toLowerCase().includes('error') || line.toLowerCase().includes('failed') ? ' log-line--error' : ' log-line--info'}`}>
                      {line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Divider between auto and manual sections */}
          {relevant.length > 0 && phase === 'idle' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0 16px' }}>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>or set up manually</span>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            </div>
          )}

          {/* Manual steps — only shown when not running/done */}
          {(phase === 'idle' || phase === 'confirming') && (
            <>
              {relevant.length === 0 && (
                <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                  No medium/high-confidence call sites found. Run a scan first.
                </p>
              )}

              {installCmds.length > 0 && (
                <div className="setup-step">
                  <div className="setup-step-num">1</div>
                  <div className="setup-step-body">
                    <div className="setup-step-title">Install the wrapper</div>
                    {installCmds.map((cmd, i) => (
                      <div key={i} style={{ position: 'relative', marginBottom: 8 }}>
                        <pre className="code-block">{cmd}</pre>
                        {!cmd.startsWith('#') && (
                          <div style={{ position: 'absolute', top: 8, right: 8 }}>
                            <CopyButton text={cmd} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {relevant.length > 0 && (
                <div className="setup-step">
                  <div className="setup-step-num">2</div>
                  <div className="setup-step-body">
                    <div className="setup-step-title">Add the wrapper to each call site</div>
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
                      Each snippet replaces your existing client instantiation. The <code>findingId</code> links live traffic back to the scan result.
                    </p>
                    {relevant.map(finding => {
                      const lang = detectLang(finding.location.file)
                      const snippet = wrapperSnippet(finding, lang)
                      const lineStr = finding.location.lines.length > 0 ? `:${finding.location.lines[0]}` : ''
                      return (
                        <div key={finding.id} className="finding-snippet">
                          <div className="finding-snippet-header">
                            <span className="finding-snippet-file">{finding.location.file}{lineStr}</span>
                            <span className="badge badge--gray" style={{ fontSize: 10 }}>{finding.provider}</span>
                            <span className="badge badge--gray" style={{ fontSize: 10 }}>{finding.id}</span>
                            <div style={{ marginLeft: 'auto' }}><CopyButton text={snippet} /></div>
                          </div>
                          <pre className="code-block" style={{ marginTop: 6, fontSize: 11 }}>{snippet}</pre>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="setup-step">
                <div className="setup-step-num">{relevant.length > 0 ? 3 : 2}</div>
                <div className="setup-step-body">
                  <div className="setup-step-title">Run your app and verify</div>
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                    Each LLM call appends one event to <code>~/.diagnostic_agent/events.jsonl</code>. To validate:
                  </p>
                  <div style={{ position: 'relative', marginBottom: 8 }}>
                    <pre className="code-block">pnpm run validate-events -- ~/.diagnostic_agent/events.jsonl</pre>
                    <div style={{ position: 'absolute', top: 8, right: 8 }}>
                      <CopyButton text="pnpm run validate-events -- ~/.diagnostic_agent/events.jsonl" />
                    </div>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    Once events are written, click <strong>Analyze Inputs</strong> on the home screen.
                  </p>
                </div>
              </div>

              <div className="info-box" style={{ marginTop: 16, fontSize: 12 }}>
                <strong>Privacy:</strong> Telemetry is local-only — events stay on disk at{' '}
                <code>~/.diagnostic_agent/events.jsonl</code>. Input prompts are captured but model output is never stored.
                Set <code>DIAGNOSTIC_AGENT_TELEMETRY=0</code> to disable writes without removing the wrapper.
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn--primary" onClick={onClose}>
            {phase === 'done' ? 'Close' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  )
}
