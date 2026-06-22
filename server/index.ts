import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'
import net from 'net'
import { spawn } from 'child_process'
import express from 'express'
import cors from 'cors'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')
const workDir = path.join(os.homedir(), '.diagnostic_agent', 'ui-workspace')
const eventsPath = path.join(os.homedir(), '.diagnostic_agent', 'events.jsonl')
const jobsPath = path.join(os.homedir(), '.diagnostic_agent', 'scheduled-jobs.json')
const tsxBin = path.join(rootDir, 'node_modules', '.bin', 'tsx')
const nanoclawRoot = process.env.NANOCLAW_ROOT ?? path.join(rootDir, '..', 'nanoclaw')
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

fs.mkdirSync(workDir, { recursive: true })

// ── Scheduled jobs ────────────────────────────────────────────────────────────

interface ScheduledJob {
  id: string
  type: 'disable-telemetry' | 'remove-telemetry'
  scheduledFor: string      // ISO timestamp
  repoPath: string | null
  findings?: Array<{ id: string; provider: string; location: { file: string; lines: number[] }; confidence: string; evidence: string }>
  createdAt: string
  executed: boolean
}

function loadJobs(): ScheduledJob[] {
  if (!fs.existsSync(jobsPath)) return []
  try { return JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as ScheduledJob[] } catch { return [] }
}

function saveJobs(jobs: ScheduledJob[]): void {
  fs.mkdirSync(path.dirname(jobsPath), { recursive: true })
  fs.writeFileSync(jobsPath, JSON.stringify(jobs, null, 2), 'utf-8')
}

function addJob(job: Omit<ScheduledJob, 'id' | 'createdAt' | 'executed'>): ScheduledJob {
  const jobs = loadJobs()
  const newJob: ScheduledJob = { ...job, id: `job-${Date.now()}`, createdAt: new Date().toISOString(), executed: false }
  jobs.push(newJob)
  saveJobs(jobs)
  return newJob
}

function buildRemovalPrompt(
  findings: ScheduledJob['findings'],
  repoPath: string | null,
): string {
  const sites = (findings ?? []).map(f => {
    const lineStr = f.location.lines.length > 0 ? ` line ${f.location.lines[0]}` : ''
    return `  • ${f.location.file}${lineStr} — provider: ${f.provider}, finding_id: "${f.id}"`
  }).join('\n')

  return `Previously you added AI cost telemetry wrappers to a project${repoPath ? ` at: ${repoPath}` : ''}. The 24-hour telemetry period has ended. Please now REMOVE the wrappers from each call site.

Call sites that were instrumented:
${sites}

For each file, remove:
- The diagnostic_agent_telemetry / diagnostic-agent/telemetry import line
- The wrapper call — restore the original client instantiation (e.g. change \`const client = instrumentAnthropic(new Anthropic(), ...)\` back to \`const client = new Anthropic()\`)

Rules:
- Make MINIMAL changes — only remove what was added. Do not touch any other code.
- When finished, print a summary of files restored.`
}

function executeJob(job: ScheduledJob): void {
  broadcastLog(`[schedule] Executing scheduled job: ${job.type}`)

  if (job.type === 'disable-telemetry') {
    // Write DIAGNOSTIC_AGENT_TELEMETRY=0 into the project's .env
    const envFile = job.repoPath ? path.join(job.repoPath, '.env') : null
    if (envFile) {
      try {
        let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : ''
        if (content.includes('DIAGNOSTIC_AGENT_TELEMETRY')) {
          content = content.replace(/^DIAGNOSTIC_AGENT_TELEMETRY=.*/m, 'DIAGNOSTIC_AGENT_TELEMETRY=0')
        } else {
          content += (content.endsWith('\n') || content === '' ? '' : '\n') + 'DIAGNOSTIC_AGENT_TELEMETRY=0\n'
        }
        fs.writeFileSync(envFile, content, 'utf-8')
        broadcastLog('[schedule] ✓ Telemetry disabled — set DIAGNOSTIC_AGENT_TELEMETRY=0 in .env')
        // Update state to reflect expiry has been applied
        state.telemetryExpiresAt = null
      } catch (err) {
        broadcastLog(`[schedule] ✗ Could not write .env: ${err instanceof Error ? err.message : err}`)
      }
    } else {
      broadcastLog('[schedule] ✗ No repo path — cannot locate .env to disable telemetry')
    }
  }

  if (job.type === 'remove-telemetry') {
    const prompt = buildRemovalPrompt(job.findings, job.repoPath)
    broadcastLog('[schedule] Sending removal task to Nanoclaw...')
    const child = spawn(pnpmBin, ['run', 'chat', '--', prompt], {
      cwd: nanoclawRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (data: Buffer) => {
      data.toString().split('\n').forEach(line => { if (line.trim()) broadcastLog(`[schedule] ${line.trim()}`) })
    })
    child.stderr.on('data', (data: Buffer) => {
      data.toString().split('\n').forEach(line => { if (line.trim()) broadcastLog(`[schedule] ${line.trim()}`) })
    })
    child.on('close', (code: number | null) => {
      if (code === 0) {
        broadcastLog('[schedule] ✓ Wrapper code removed from repository')
        state.telemetryRemoveAt = null
      } else {
        broadcastLog(`[schedule] ✗ Removal failed (exit ${code}) — is Nanoclaw running?`)
      }
    })
  }

  // Mark executed
  const jobs = loadJobs()
  const idx = jobs.findIndex(j => j.id === job.id)
  if (idx >= 0) { jobs[idx].executed = true; saveJobs(jobs) }
}

function checkDueJobs(): void {
  const now = new Date()
  const jobs = loadJobs()
  for (const job of jobs) {
    if (!job.executed && new Date(job.scheduledFor) <= now) {
      executeJob(job)
    }
  }
}

// Restore telemetryExpiresAt / telemetryRemoveAt from pending jobs on startup
function restoreScheduledState(): { expiresAt: string | null; removeAt: string | null } {
  const jobs = loadJobs().filter(j => !j.executed && new Date(j.scheduledFor) > new Date())
  const disable = jobs.find(j => j.type === 'disable-telemetry')
  const remove = jobs.find(j => j.type === 'remove-telemetry')
  return { expiresAt: disable?.scheduledFor ?? null, removeAt: remove?.scheduledFor ?? null }
}

const app = express()
app.use(cors())
app.use(express.json())

type JobStatus = 'idle' | 'running' | 'done' | 'error'

// Restore status from existing output files so the UI doesn't lose its
// results when the server restarts (output files persist across restarts).
function existingStatus(filePath: string): JobStatus {
  return fs.existsSync(filePath) ? 'done' : 'idle'
}

const { expiresAt: _initExpires, removeAt: _initRemove } = restoreScheduledState()

const state = {
  repoPath: null as string | null,
  scanStatus: existingStatus(path.join(workDir, 'ai-usage-findings.json')),
  estimateStatus: existingStatus(path.join(workDir, 'spend-estimate.json')),
  analyzeStatus: existingStatus(path.join(workDir, 'input-analysis.json')),
  scanError: null as string | null,
  estimateError: null as string | null,
  analyzeError: null as string | null,
  diagnosisStatus: 'idle' as JobStatus,
  diagnosisError: null as string | null,
  instrumentStatus: 'idle' as JobStatus,
  instrumentError: null as string | null,
  telemetryExpiresAt: _initExpires,  // ISO string — when env-var disable fires
  telemetryRemoveAt: _initRemove,    // ISO string — when code removal fires (null if not scheduled)
  lastPreset: 'balanced',
}

// Run due jobs on startup and every 30 seconds
checkDueJobs()
setInterval(checkDueJobs, 30_000)

const sseClients = new Set<express.Response>()

function broadcast(event: object): void {
  const data = `data: ${JSON.stringify(event)}\n\n`
  for (const res of sseClients) {
    try { res.write(data) } catch { sseClients.delete(res) }
  }
}

function broadcastLog(message: string): void {
  broadcast({ type: 'log', message })
}

function broadcastStatus(kind: string, status: string, error?: string): void {
  broadcast({ type: 'status', kind, status, ...(error ? { error } : {}) })
}

// GET /api/state
app.get('/api/state', (_req, res) => {
  res.json({
    ...state,
    hasFindings: fs.existsSync(path.join(workDir, 'ai-usage-findings.json')),
    hasEstimate: fs.existsSync(path.join(workDir, 'spend-estimate.json')),
    hasAnalysis: fs.existsSync(path.join(workDir, 'input-analysis.json')),
    hasEvents: fs.existsSync(eventsPath),
  })
})

function runDiagnosisJob(errorOutput: string): void {
  state.diagnosisStatus = 'running'
  state.diagnosisError = null
  broadcastStatus('diagnosis', 'running')
  broadcastLog('[diagnosis] Asking Nanoclaw to diagnose the scan error...')

  const prompt =
    `The AI Cost Diagnostic deep scan just failed. Here is the error output:\n\n${errorOutput}\n\n` +
    `Please explain what went wrong and provide clear step-by-step instructions to fix it.`

  const child = spawn(pnpmBin, ['run', 'chat', '--', prompt], {
    cwd: nanoclawRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(line => {
      if (line.trim()) broadcastLog(`[diagnosis] ${line.trim()}`)
    })
  })
  child.stderr.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(line => {
      if (line.trim()) broadcastLog(`[diagnosis] ${line.trim()}`)
    })
  })
  child.on('close', (code: number | null) => {
    if (code === 0) {
      state.diagnosisStatus = 'done'
      broadcastLog('[diagnosis] ✓ Diagnosis complete')
    } else {
      state.diagnosisStatus = 'error'
      state.diagnosisError = `Diagnosis failed (exit ${code}) — is Nanoclaw running?`
      broadcastLog(`[diagnosis] ✗ Could not reach Nanoclaw for diagnosis (exit ${code})`)
    }
    broadcastStatus('diagnosis', state.diagnosisStatus, state.diagnosisError ?? undefined)
  })
}

// POST /api/validate-path
app.post('/api/validate-path', (req, res) => {
  const { path: p } = req.body as { path: string }
  try {
    const stat = fs.statSync(p)
    res.json({ valid: true, isDirectory: stat.isDirectory() })
  } catch {
    res.json({ valid: false, isDirectory: false })
  }
})

// Probe the Nanoclaw Unix socket by sending a 'help' command frame.
// The socket lives at <nanoclaw-dir>/data/ncl.sock.
// Returns true if Nanoclaw is actually running and responds within 3 s.
function probeNanoclawSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { client.destroy(); resolve(false) }, 3000)
    const client = net.createConnection(socketPath)
    let buf = ''

    client.on('connect', () => {
      client.write(JSON.stringify({ id: 'health', command: 'help', args: {} }) + '\n')
    })
    client.on('data', (chunk) => {
      buf += chunk.toString()
      if (buf.includes('\n')) {
        clearTimeout(timeout)
        client.destroy()
        try {
          const frame = JSON.parse(buf.split('\n')[0]) as { ok?: boolean }
          resolve(frame.ok === true || 'ok' in frame)
        } catch { resolve(true) } // got a response — socket is live
      }
    })
    client.on('error', () => { clearTimeout(timeout); resolve(false) })
    client.on('close', () => { clearTimeout(timeout) })
  })
}

// GET /api/nanoclaw-check
app.get('/api/nanoclaw-check', async (_req, res) => {
  const socketPath = path.join(nanoclawRoot, 'data', 'ncl.sock')
  const socketExists = fs.existsSync(socketPath)

  if (!socketExists) {
    res.json({ socketExists: false, responding: false, ready: false, socketPath })
    return
  }

  const responding = await probeNanoclawSocket(socketPath)
  res.json({ socketExists: true, responding, ready: responding, socketPath })
})

// GET /api/logs  (SSE)
app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.write(': connected\n\n')
  sseClients.add(res)
  req.on('close', () => sseClients.delete(res))
})

// POST /api/scan
app.post('/api/scan', (req, res) => {
  const { repoPath, mode = 'static' } = req.body as { repoPath: string; mode?: string }

  if (!repoPath) { res.status(400).json({ error: 'repoPath required' }); return }
  if (state.scanStatus === 'running') { res.status(409).json({ error: 'Scan already running' }); return }

  state.repoPath = repoPath
  state.scanStatus = 'running'
  state.scanError = null
  state.diagnosisStatus = 'idle'
  state.diagnosisError = null
  // Reset downstream statuses when re-scanning
  state.estimateStatus = 'idle'
  state.analyzeStatus = 'idle'
  broadcastStatus('scan', 'running')

  const outputPath = path.join(workDir, 'ai-usage-findings.json')
  const args = [
    'cli/index.ts', 'discover',
    '--repo', repoPath,
    '--output', outputPath,
    '--normalize',
  ]
  if (mode === 'static') args.push('--static')

  const child = spawn(tsxBin, args, { cwd: rootDir })
  const outputLines: string[] = []

  child.stdout.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(line => {
      if (line.trim()) { broadcastLog(line.trim()); outputLines.push(line.trim()) }
    })
  })
  child.stderr.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(line => {
      if (line.trim()) { broadcastLog(line.trim()); outputLines.push(line.trim()) }
    })
  })
  child.on('close', (code: number | null) => {
    if (code === 0) {
      state.scanStatus = 'done'
      broadcastLog('✓ Scan complete')
    } else {
      state.scanStatus = 'error'
      state.scanError = `Scan exited with code ${code}`
      broadcastLog(`✗ Scan failed (exit ${code})`)
      if (mode === 'full') {
        runDiagnosisJob(outputLines.slice(-100).join('\n'))
      }
    }
    broadcastStatus('scan', state.scanStatus, state.scanError ?? undefined)
    if (code === 0) runEstimateJob()
  })

  res.json({ started: true })
})

// GET /api/findings
app.get('/api/findings', (_req, res) => {
  const p = path.join(workDir, 'ai-usage-findings.json')
  if (!fs.existsSync(p)) { res.status(404).json({ error: 'No findings yet' }); return }
  res.json(JSON.parse(fs.readFileSync(p, 'utf-8')))
})

// POST /api/estimate
app.post('/api/estimate', (req, res) => {
  const { callsPerMonth } = req.body as { callsPerMonth?: number }
  if (state.estimateStatus === 'running') { res.status(409).json({ error: 'Already running' }); return }
  runEstimateJob(callsPerMonth)
  res.json({ started: true })
})

function runEstimateJob(callsPerMonth?: number): void {
  const findingsPath = path.join(workDir, 'ai-usage-findings.json')
  if (!fs.existsSync(findingsPath)) return

  state.estimateStatus = 'running'
  state.estimateError = null
  broadcastStatus('estimate', 'running')

  const outputPath = path.join(workDir, 'spend-estimate.json')
  const args = [
    'cli/index.ts', 'estimate',
    '--findings', findingsPath,
    '--output', outputPath,
  ]
  if (fs.existsSync(eventsPath)) args.push('--events', eventsPath)
  if (callsPerMonth) args.push('--calls-per-month', String(callsPerMonth))

  const child = spawn(tsxBin, args, { cwd: rootDir })

  child.stdout.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(line => { if (line.trim()) broadcastLog(`[estimate] ${line.trim()}`) })
  })
  child.stderr.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(line => { if (line.trim()) broadcastLog(`[estimate] ${line.trim()}`) })
  })
  child.on('close', (code: number | null) => {
    if (code === 0) {
      state.estimateStatus = 'done'
      broadcastLog('✓ Cost estimate ready')
    } else {
      state.estimateStatus = 'error'
      state.estimateError = `Estimate exited with code ${code}`
    }
    broadcastStatus('estimate', state.estimateStatus, state.estimateError ?? undefined)
  })
}

// GET /api/estimate
app.get('/api/estimate', (_req, res) => {
  const p = path.join(workDir, 'spend-estimate.json')
  if (!fs.existsSync(p)) { res.status(404).json({ error: 'No estimate yet' }); return }
  res.json(JSON.parse(fs.readFileSync(p, 'utf-8')))
})

// POST /api/analyze
app.post('/api/analyze', (req, res) => {
  const { preset = 'balanced' } = req.body as { preset?: string }

  if (!fs.existsSync(eventsPath)) { res.status(400).json({ error: 'No telemetry events found' }); return }
  if (state.analyzeStatus === 'running') { res.status(409).json({ error: 'Already running' }); return }

  state.analyzeStatus = 'running'
  state.analyzeError = null
  state.lastPreset = preset
  broadcastStatus('analyze', 'running')

  const outputPath = path.join(workDir, 'input-analysis.json')
  const args = [
    'cli/index.ts', 'analyze-inputs',
    '--events', eventsPath,
    '--output', outputPath,
    '--preset', preset,
  ]

  const child = spawn(tsxBin, args, { cwd: rootDir })

  child.stdout.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(line => { if (line.trim()) broadcastLog(`[analyze] ${line.trim()}`) })
  })
  child.stderr.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(line => { if (line.trim()) broadcastLog(`[analyze] ${line.trim()}`) })
  })
  child.on('close', (code: number | null) => {
    if (code === 0) {
      state.analyzeStatus = 'done'
      broadcastLog('✓ Input analysis complete')
    } else {
      state.analyzeStatus = 'error'
      state.analyzeError = `Analysis exited with code ${code}`
    }
    broadcastStatus('analyze', state.analyzeStatus, state.analyzeError ?? undefined)
  })

  res.json({ started: true })
})

// GET /api/analyze
app.get('/api/analyze', (_req, res) => {
  const p = path.join(workDir, 'input-analysis.json')
  if (!fs.existsSync(p)) { res.status(404).json({ error: 'No analysis yet' }); return }
  res.json(JSON.parse(fs.readFileSync(p, 'utf-8')))
})

// POST /api/instrument  — ask Nanoclaw to install the wrapper + patch all call sites
app.post('/api/instrument', (req, res) => {
  const findingsPath = path.join(workDir, 'ai-usage-findings.json')
  if (!fs.existsSync(findingsPath)) {
    res.status(400).json({ error: 'No findings yet — run a scan first' }); return
  }
  if (state.instrumentStatus === 'running') {
    res.status(409).json({ error: 'Already running' }); return
  }

  const { durationHours, removeFromCode } = (req.body ?? {}) as {
    durationHours?: number
    removeFromCode?: boolean
  }

  const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf-8')) as {
    findings: Array<{ id: string; provider: string; location: { file: string; lines: number[] }; confidence: string; evidence: string }>
  }

  // Schedule expiry jobs before starting so state is visible immediately
  if (durationHours && durationHours > 0) {
    const expiresAt = new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString()

    const disableJob = addJob({ type: 'disable-telemetry', scheduledFor: expiresAt, repoPath: state.repoPath })
    state.telemetryExpiresAt = disableJob.scheduledFor

    if (removeFromCode) {
      const removeJob = addJob({
        type: 'remove-telemetry',
        scheduledFor: expiresAt,
        repoPath: state.repoPath,
        findings: findings.findings.filter(f => f.confidence !== 'low'),
      })
      state.telemetryRemoveAt = removeJob.scheduledFor
    }
  } else {
    state.telemetryExpiresAt = null
    state.telemetryRemoveAt = null
  }

  state.instrumentStatus = 'running'
  state.instrumentError = null
  broadcastStatus('instrument', 'running')
  runInstrumentJob(findings, state.repoPath)
  res.json({ started: true })
})

function buildInstrumentPrompt(
  findings: { findings: Array<{ id: string; provider: string; location: { file: string; lines: number[] }; confidence: string; evidence: string }> },
  repoPath: string | null,
): string {
  const callSites = findings.findings.filter(f => f.confidence !== 'low')
  const hasPy = callSites.some(f => f.location.file.endsWith('.py'))
  const hasTs = callSites.some(f => !f.location.file.endsWith('.py'))

  const installLines: string[] = []
  if (hasPy) installLines.push(`- Python: pip install -e "${rootDir}/telemetry/python" from within the project directory`)
  if (hasTs) installLines.push(`- TypeScript/JS: add diagnostic-agent as a local dependency (e.g. pnpm add "${rootDir}" or npm install "${rootDir}") using whatever package manager the project uses`)

  const sitesList = callSites.map(f => {
    const lineStr = f.location.lines.length > 0 ? ` line ${f.location.lines[0]}` : ''
    return `  • ${f.location.file}${lineStr} — provider: ${f.provider}, finding_id: "${f.id}", evidence: ${f.evidence}`
  }).join('\n')

  return `You need to add AI cost telemetry wrappers to a project${repoPath ? ` at: ${repoPath}` : ''}.

STEP 1 — Install the telemetry package:
${installLines.length > 0 ? installLines.join('\n') : '  (nothing to install)'}

STEP 2 — Add the wrapper to each call site listed below. Work through them file by file.

Call sites to instrument:
${sitesList}

For TypeScript/JS files:
  Add import:  import { instrumentAnthropic } from 'diagnostic-agent/telemetry'
               import { instrumentOpenAI }    from 'diagnostic-agent/telemetry'
  Wrap client: const client = instrumentAnthropic(new Anthropic(), { findingId: '<id>' })
               const client = instrumentOpenAI(new OpenAI(), { findingId: '<id>' })

For Python files:
  Add import:  from diagnostic_agent_telemetry import instrument_anthropic
               from diagnostic_agent_telemetry import instrument_openai
  Wrap client: client = instrument_anthropic(Anthropic(), finding_id="<id>")
               instrument_openai(client, finding_id="<id>")  # if client is already assigned

Rules — follow these exactly:
- Use the exact finding_id shown for each call site
- Make MINIMAL changes: only add the import and wrap the client. Do not refactor anything else.
- If a file already imports the wrapper, skip the duplicate import
- If the client is already in a variable, wrap it in place (e.g. client = instrumentAnthropic(client, ...))
- When finished, print a summary listing each file modified and what changed`
}

function runInstrumentJob(
  findings: { findings: Array<{ id: string; provider: string; location: { file: string; lines: number[] }; confidence: string; evidence: string }> },
  repoPath: string | null,
): void {
  const prompt = buildInstrumentPrompt(findings, repoPath)

  broadcastLog('[instrument] Sending instrumentation task to Nanoclaw...')

  const child = spawn(pnpmBin, ['run', 'chat', '--', prompt], {
    cwd: nanoclawRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(line => {
      if (line.trim()) broadcastLog(`[instrument] ${line.trim()}`)
    })
  })
  child.stderr.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(line => {
      if (line.trim()) broadcastLog(`[instrument] ${line.trim()}`)
    })
  })
  child.on('close', (code: number | null) => {
    if (code === 0) {
      state.instrumentStatus = 'done'
      broadcastLog('[instrument] ✓ Instrumentation complete')
    } else {
      state.instrumentStatus = 'error'
      state.instrumentError = `Nanoclaw exited with code ${code} — is it running?`
      broadcastLog(`[instrument] ✗ Instrumentation failed (exit ${code})`)
    }
    broadcastStatus('instrument', state.instrumentStatus, state.instrumentError ?? undefined)
  })
}

// Serve built UI in production
const uiDist = path.join(__dirname, '..', 'ui', 'dist')
if (fs.existsSync(uiDist)) {
  app.use(express.static(uiDist))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(uiDist, 'index.html'))
  })
}

const PORT = process.env.PORT ?? 3001
app.listen(PORT, () => {
  console.log(`\nAI Cost Diagnostic server → http://localhost:${PORT}`)
  if (!fs.existsSync(uiDist)) {
    console.log('UI dev server        → http://localhost:5173  (run pnpm --filter ui dev)\n')
  }
})
