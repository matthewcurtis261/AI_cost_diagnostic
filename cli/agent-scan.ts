#!/usr/bin/env node
/**
 * agent-scan: reads ~/.claude/projects/** JSONL session files and produces
 * an AgentReport with token counts, costs, trends, and savings estimates.
 */
import fs from 'fs'
import path from 'path'
import os from 'os'

// ── Pricing (USD per 1M tokens) ───────────────────────────────────────────────
// cache_write = 125% of input; cache_read = 10% of input
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8':    { input: 15.00, output: 75.00 },
  'claude-opus-4-7':    { input: 15.00, output: 75.00 },
  'claude-opus-4-6':    { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':  { input:  3.00, output: 15.00 },
  'claude-sonnet-4-5':  { input:  3.00, output: 15.00 },
  'claude-haiku-4-5':   { input:  0.80, output:  4.00 },
  'claude-opus-3-5':    { input: 15.00, output: 75.00 },
  'claude-sonnet-3-7':  { input:  3.00, output: 15.00 },
  'claude-sonnet-3-5':  { input:  3.00, output: 15.00 },
  'claude-haiku-3-5':   { input:  0.80, output:  4.00 },
  'claude-haiku-3':     { input:  0.25, output:  1.25 },
}

const HAIKU_PRICING = { input: 0.80, output: 4.00 }

function priceFor(model: string): { input: number; output: number } {
  // exact match
  if (PRICING[model]) return PRICING[model]
  // prefix match (handles versioned IDs like claude-sonnet-4-6-20250101)
  const key = Object.keys(PRICING).find(k => model.startsWith(k))
  return key ? PRICING[key] : { input: 3.00, output: 15.00 } // default Sonnet
}

function calcCost(
  inputTokens: number,
  outputTokens: number,
  cacheCreate: number,
  cacheRead: number,
  model: string,
): number {
  const p = priceFor(model)
  const M = 1_000_000
  return (
    (inputTokens   * p.input)          / M +
    (outputTokens  * p.output)         / M +
    (cacheCreate   * p.input * 1.25)   / M +
    (cacheRead     * p.input * 0.10)   / M
  )
}

function calcCostHaiku(
  inputTokens: number,
  outputTokens: number,
  cacheCreate: number,
  cacheRead: number,
): number {
  const M = 1_000_000
  return (
    (inputTokens   * HAIKU_PRICING.input)          / M +
    (outputTokens  * HAIKU_PRICING.output)         / M +
    (cacheCreate   * HAIKU_PRICING.input * 1.25)   / M +
    (cacheRead     * HAIKU_PRICING.input * 0.10)   / M
  )
}

// Cache reads before a compact are replaced with this many tokens total
const COMPACT_RESET_TOKENS = 10_000

// ── Types ─────────────────────────────────────────────────────────────────────

interface UsageEntry {
  sessionId: string
  projectPath: string   // cwd or decoded folder
  tool: 'nanoclaw' | 'claude-code'
  model: string
  timestamp: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd: number
}

// ── JSONL parsing ─────────────────────────────────────────────────────────────

interface RawEntry {
  type?: string
  subtype?: string
  message?: {
    role?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  timestamp?: string
  sessionId?: string
  cwd?: string
}

function parseSessionFile(filePath: string, projectPath: string): UsageEntry[] {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  const lines = content.split('\n')
  const assistantRaw: RawEntry[] = []
  const compactTimestamps: string[] = []

  for (const line of lines) {
    if (!line.trim()) continue
    let entry: RawEntry
    try { entry = JSON.parse(line) } catch { continue }

    if (entry.type === 'assistant') assistantRaw.push(entry)
    if (entry.type === 'system' && entry.subtype === 'compact_boundary' && entry.timestamp) {
      compactTimestamps.push(entry.timestamp)
    }
  }

  if (assistantRaw.length === 0) return []

  const sortedCompacts = [...compactTimestamps].sort()

  function makeEntry(raw: RawEntry, correctedCacheRead: number): UsageEntry | null {
    const usage = raw.message?.usage
    if (!usage) return null
    const input   = usage.input_tokens  ?? 0
    const output  = usage.output_tokens ?? 0
    const cCreate = usage.cache_creation_input_tokens ?? 0
    const cRead   = correctedCacheRead
    const model   = raw.message?.model ?? 'unknown'
    const cwd     = raw.cwd ?? projectPath
    const tool: 'nanoclaw' | 'claude-code' = cwd.toLowerCase().includes('nanoclaw') ? 'nanoclaw' : 'claude-code'
    return {
      sessionId:           raw.sessionId ?? path.basename(filePath, '.jsonl'),
      projectPath:         cwd,
      tool,
      model,
      timestamp:           raw.timestamp ?? new Date().toISOString(),
      inputTokens:         input,
      outputTokens:        output,
      cacheCreationTokens: cCreate,
      cacheReadTokens:     cRead,
      costUsd:             calcCost(input, output, cCreate, cRead, model),
    }
  }

  const entries: UsageEntry[] = []
  let segmentStart = 0

  for (const compactTs of sortedCompacts) {
    let nextStart = segmentStart
    let segmentCacheRead = 0
    for (let i = segmentStart; i < assistantRaw.length; i++) {
      if ((assistantRaw[i].timestamp ?? '') > compactTs) { nextStart = i; break }
      if (i === assistantRaw.length - 1) nextStart = assistantRaw.length
      segmentCacheRead += assistantRaw[i].message?.usage?.cache_read_input_tokens ?? 0
    }
    // Pre-compact segment: zero out all cacheRead, assign correction to last entry
    const correctionTokens = segmentCacheRead > 0 ? COMPACT_RESET_TOKENS : 0
    for (let i = segmentStart; i < nextStart; i++) {
      const cacheRead = (i === nextStart - 1) ? correctionTokens : 0
      const e = makeEntry(assistantRaw[i], cacheRead)
      if (e) entries.push(e)
    }
    segmentStart = nextStart
  }

  // Final segment (after last compact, or entire session if no compacts): actual values
  for (let i = segmentStart; i < assistantRaw.length; i++) {
    const cacheRead = assistantRaw[i].message?.usage?.cache_read_input_tokens ?? 0
    const e = makeEntry(assistantRaw[i], cacheRead)
    if (e) entries.push(e)
  }

  return entries
}

// ── Folder decoding ───────────────────────────────────────────────────────────
// Claude Code encodes paths by replacing '/' with '-'. Since this is lossy for
// paths with hyphens, we prefer `cwd` from the JSONL data where available.
function decodeFolderName(name: string): string {
  // strip leading '-' and replace remaining '-' with '/'
  return '/' + name.replace(/^-/, '').replace(/-/g, '/')
}

// ── Main scan ─────────────────────────────────────────────────────────────────

function scan(): object {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects')
  const allEntries: UsageEntry[] = []

  if (!fs.existsSync(claudeProjectsDir)) {
    console.error(`No ~/.claude/projects directory found at ${claudeProjectsDir}`)
    return buildReport(allEntries)
  }

  const projectFolders = fs.readdirSync(claudeProjectsDir)
  for (const folder of projectFolders) {
    const folderPath = path.join(claudeProjectsDir, folder)
    const stat = fs.statSync(folderPath)
    if (!stat.isDirectory()) continue

    const decodedPath = decodeFolderName(folder)
    const jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'))
    for (const jf of jsonlFiles) {
      const entries = parseSessionFile(path.join(folderPath, jf), decodedPath)
      allEntries.push(...entries)
    }
  }

  return buildReport(allEntries)
}

function buildReport(entries: UsageEntry[]): object {
  // ── Totals ──
  const totals = {
    messages: entries.length,
    inputTokens:         entries.reduce((s, e) => s + e.inputTokens, 0),
    outputTokens:        entries.reduce((s, e) => s + e.outputTokens, 0),
    cacheCreationTokens: entries.reduce((s, e) => s + e.cacheCreationTokens, 0),
    cacheReadTokens:     entries.reduce((s, e) => s + e.cacheReadTokens, 0),
    costUsd:             entries.reduce((s, e) => s + e.costUsd, 0),
  }

  // unique sessions
  const sessionSet = new Set(entries.map(e => e.sessionId))
  const sessionCount = sessionSet.size

  // ── By project ──
  const byProject: Record<string, {
    label: string; tool: string; sessions: Set<string>
    inputTokens: number; outputTokens: number
    cacheCreationTokens: number; cacheReadTokens: number; costUsd: number
  }> = {}

  for (const e of entries) {
    if (!byProject[e.projectPath]) {
      const parts = e.projectPath.split('/').filter(Boolean)
      const label = parts.slice(-2).join('/')
      byProject[e.projectPath] = {
        label, tool: e.tool, sessions: new Set(),
        inputTokens: 0, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0,
      }
    }
    const p = byProject[e.projectPath]
    p.sessions.add(e.sessionId)
    p.inputTokens         += e.inputTokens
    p.outputTokens        += e.outputTokens
    p.cacheCreationTokens += e.cacheCreationTokens
    p.cacheReadTokens     += e.cacheReadTokens
    p.costUsd             += e.costUsd
  }

  const byProjectOut: Record<string, object> = {}
  for (const [k, v] of Object.entries(byProject)) {
    byProjectOut[k] = { ...v, sessions: v.sessions.size }
  }

  // ── By model ──
  const byModel: Record<string, { sessions: Set<string>; inputTokens: number; outputTokens: number; costUsd: number }> = {}
  for (const e of entries) {
    if (!byModel[e.model]) byModel[e.model] = { sessions: new Set(), inputTokens: 0, outputTokens: 0, costUsd: 0 }
    byModel[e.model].sessions.add(e.sessionId)
    byModel[e.model].inputTokens  += e.inputTokens
    byModel[e.model].outputTokens += e.outputTokens
    byModel[e.model].costUsd      += e.costUsd
  }
  const byModelOut: Record<string, object> = {}
  for (const [k, v] of Object.entries(byModel)) {
    byModelOut[k] = { ...v, sessions: v.sessions.size }
  }

  // ── By tool ──
  const byTool: Record<string, { sessions: Set<string>; costUsd: number }> = {}
  for (const e of entries) {
    if (!byTool[e.tool]) byTool[e.tool] = { sessions: new Set(), costUsd: 0 }
    byTool[e.tool].sessions.add(e.sessionId)
    byTool[e.tool].costUsd += e.costUsd
  }
  const byToolOut: Record<string, object> = {}
  for (const [k, v] of Object.entries(byTool)) {
    byToolOut[k] = { sessions: v.sessions.size, costUsd: v.costUsd }
  }

  // ── Trend (last 90 days, grouped by day) ──
  const trendMap: Record<string, { inputTokens: number; outputTokens: number; costUsd: number; sessions: Set<string> }> = {}
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  for (const e of entries) {
    const d = new Date(e.timestamp)
    if (d < cutoff) continue
    const key = d.toISOString().slice(0, 10)
    if (!trendMap[key]) trendMap[key] = { inputTokens: 0, outputTokens: 0, costUsd: 0, sessions: new Set() }
    trendMap[key].inputTokens  += e.inputTokens
    trendMap[key].outputTokens += e.outputTokens
    trendMap[key].costUsd      += e.costUsd
    trendMap[key].sessions.add(e.sessionId)
  }
  const trend = Object.entries(trendMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, inputTokens: v.inputTokens, outputTokens: v.outputTokens, costUsd: v.costUsd, sessions: v.sessions.size }))

  // ── Potential savings (if all runs used Haiku) ──
  const haikuCost = entries.reduce((s, e) =>
    s + calcCostHaiku(e.inputTokens, e.outputTokens, e.cacheCreationTokens, e.cacheReadTokens), 0)
  const potentialSavings = {
    if_downgrade_to_haiku: {
      savingsUsd: Math.max(0, totals.costUsd - haikuCost),
      savingsPct: totals.costUsd > 0 ? Math.round(Math.max(0, (totals.costUsd - haikuCost) / totals.costUsd) * 100) : 0,
    }
  }

  return {
    scanned_at: new Date().toISOString(),
    totals: { ...totals, sessions: sessionCount },
    by_project: byProjectOut,
    by_model:   byModelOut,
    by_tool:    byToolOut,
    trend,
    potential_savings: potentialSavings,
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
const outputArg = process.argv.indexOf('--output')
const outputPath = outputArg >= 0 ? process.argv[outputArg + 1] : null

const report = scan()
const json = JSON.stringify(report, null, 2)

if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, json, 'utf-8')
  console.log(`✓ Agent scan complete → ${outputPath}`)
} else {
  process.stdout.write(json + '\n')
}
