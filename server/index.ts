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
const tsxBin = path.join(rootDir, 'node_modules', '.bin', 'tsx')

fs.mkdirSync(workDir, { recursive: true })

const app = express()
app.use(cors())
app.use(express.json())

type JobStatus = 'idle' | 'running' | 'done' | 'error'

// Restore status from existing output files so the UI doesn't lose its
// results when the server restarts (output files persist across restarts).
function existingStatus(filePath: string): JobStatus {
  return fs.existsSync(filePath) ? 'done' : 'idle'
}

const state = {
  repoPath: null as string | null,
  scanStatus: existingStatus(path.join(workDir, 'ai-usage-findings.json')),
  estimateStatus: existingStatus(path.join(workDir, 'spend-estimate.json')),
  analyzeStatus: existingStatus(path.join(workDir, 'input-analysis.json')),
  scanError: null as string | null,
  estimateError: null as string | null,
  analyzeError: null as string | null,
  lastPreset: 'balanced',
}

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
  // Nanoclaw socket is at <nanoclaw-dir>/data/ncl.sock
  // Look for it next to this repo (sibling directory) or via NANOCLAW_ROOT env.
  const nanoclawRoot =
    process.env.NANOCLAW_ROOT ??
    path.join(rootDir, '..', 'nanoclaw')

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

  child.stdout.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(line => { if (line.trim()) broadcastLog(line.trim()) })
  })
  child.stderr.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(line => { if (line.trim()) broadcastLog(line.trim()) })
  })
  child.on('close', (code: number | null) => {
    if (code === 0) {
      state.scanStatus = 'done'
      broadcastLog('✓ Scan complete')
    } else {
      state.scanStatus = 'error'
      state.scanError = `Scan exited with code ${code}`
      broadcastLog(`✗ Scan failed (exit ${code})`)
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
