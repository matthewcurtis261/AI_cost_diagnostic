#!/usr/bin/env node
/**
 * agent-scan-deep: extends agent-scan with per-session task fingerprinting
 * and classification. Reconstructs an approximate input payload from the
 * conversation transcript (human messages + tool call names) and classifies
 * each session to recommend the best-fit model.
 *
 * What the reconstruction CANNOT capture (tracked in reconstruction_notes):
 *  - System prompt (always injected by Claude Code, never written to disk)
 *  - Context window pruning (old messages dropped for long sessions)
 *  - File/image contents injected via @mentions
 *  - Full MCP tool manifests (only tool names are recorded)
 * These gaps mean reconstructed input_tokens will be underestimates for long
 * sessions and we cannot reproduce the exact API payload.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

import { spawnSync } from 'child_process'
import { classifyTexts } from '../input-analysis/lib/classifier.js'
import {
  loadQualityScores,
  loadModelAliases,
  resolveQualityModelId,
  taskQualityScore,
  resolveQualityPreferences,
} from '../input-analysis/lib/quality-scores.js'
import { loadPricingTable, calculateCost, getModelPricing } from '../estimate/lib/pricing.js'
import { pickBestAlternative } from '../input-analysis/lib/recommendation.js'

// Resolve python binary once at startup
const PYTHON_BIN = (() => {
  for (const bin of ['python3', 'python']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf-8' })
    if (!r.error) return bin
  }
  return 'python3'
})()

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Pricing (same as agent-scan.ts, USD per 1M tokens) ───────────────────────
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8':   { input: 15.00, output: 75.00 },
  'claude-opus-4-7':   { input: 15.00, output: 75.00 },
  'claude-opus-4-6':   { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6': { input:  3.00, output: 15.00 },
  'claude-sonnet-4-5': { input:  3.00, output: 15.00 },
  'claude-haiku-4-5':  { input:  0.80, output:  4.00 },
  'claude-opus-3-5':   { input: 15.00, output: 75.00 },
  'claude-sonnet-3-7': { input:  3.00, output: 15.00 },
  'claude-sonnet-3-5': { input:  3.00, output: 15.00 },
  'claude-haiku-3-5':  { input:  0.80, output:  4.00 },
  'claude-haiku-3':    { input:  0.25, output:  1.25 },
}

function priceFor(model: string): { input: number; output: number } {
  if (PRICING[model]) return PRICING[model]
  const key = Object.keys(PRICING).find(k => model.startsWith(k))
  return key ? PRICING[key] : { input: 3.00, output: 15.00 }
}

function calcCost(input: number, output: number, cacheCreate: number, cacheRead: number, model: string): number {
  const p = priceFor(model)
  const M = 1_000_000
  return (
    (input       * p.input)          / M +
    (output      * p.output)         / M +
    (cacheCreate * p.input * 1.25)   / M +
    (cacheRead   * p.input * 0.10)   / M
  )
}

// ── Model tiers and recommendation logic ─────────────────────────────────────
// Tier determines the minimum model capability needed for a task type.
// Labels match the classifier's label_map.json exactly.

type ModelTier = 'haiku' | 'sonnet' | 'opus'

const METRIC_TIERS: Record<string, ModelTier> = {
  // Haiku-appropriate: simple directives, lookup, extraction, conversational
  instruction_following: 'haiku',
  extraction:            'haiku',
  factuality:            'haiku',
  commonsense:           'haiku',
  roleplay:              'haiku',
  humanities_chat:       'haiku',
  // Sonnet-appropriate: coding, writing, retrieval, structured tool use
  code_completion:       'sonnet',
  repo_engineering:      'sonnet',
  tool_call:             'sonnet',
  coding_chat:           'sonnet',
  writing:               'sonnet',
  long_context_retrieval:'sonnet',
  rag_synthesis:         'sonnet',
  mcq_knowledge:         'sonnet',
  // Opus-appropriate: deep reasoning, math, science, autonomous agents
  agentic:               'opus',
  multi_step_reasoning:  'opus',
  reasoning_chat:        'opus',
  expert_science:        'opus',
  math:                  'opus',
  stem_chat:             'opus',
}

function tierFor(metricIds: string[]): ModelTier {
  if (metricIds.length === 0) return 'sonnet'
  const tiers = metricIds.map(m => METRIC_TIERS[m] ?? 'sonnet')
  if (tiers.includes('opus'))   return 'opus'
  if (tiers.includes('sonnet')) return 'sonnet'
  return 'haiku'
}

type RecommendationKind = 'downgrade' | 'upgrade'

// ── JSONL types ───────────────────────────────────────────────────────────────

interface RawAssistantEntry {
  type: 'assistant'
  uuid: string
  parentUuid?: string
  message: {
    model?: string
    content?: Array<{ type: string; id?: string; name?: string; input?: unknown; text?: string; thinking?: string }>
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

interface RawUserEntry {
  type: 'user'
  uuid: string
  parentUuid?: string
  message: {
    role?: string
    content?: string | Array<{ type: string; tool_use_id?: string; content?: string | Array<{ type: string; text?: string }> }>
  }
  timestamp?: string
  sessionId?: string
  cwd?: string
}

interface RawSystemEntry {
  type: 'system'
  subtype: string
  timestamp?: string
}

// Cache reads before a compact are replaced with this many tokens (the post-compact summary size)
const COMPACT_RESET_TOKENS = 10_000

// ── Fingerprint construction ──────────────────────────────────────────────────

const MAX_FIRST_MSG   = 500   // chars from the first human message
const MAX_FOLLOWUP    = 120   // chars per follow-up human message
const MAX_FOLLOWUPS   = 4     // how many follow-up messages to include
const PRUNING_THRESHOLD = 40  // sessions with more turns are likely to have had context pruned

function extractUserText(content: RawUserEntry['message']['content']): string | null {
  if (typeof content === 'string') return content.trim() || null
  if (Array.isArray(content)) {
    // Skip pure tool_result entries — they're not human intent
    const hasOnlyToolResults = content.every(b => typeof b === 'object' && b.type === 'tool_result')
    if (hasOnlyToolResults) return null
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'object' && block.type === 'text') {
        const t = typeof block.content === 'string' ? block.content : ''
        if (t.trim()) parts.push(t.trim())
      }
    }
    return parts.join(' ') || null
  }
  return null
}

interface SessionFingerprint {
  // Input text formatted for extractInputText()
  syntheticInput: Record<string, unknown>
  // Metadata about what we could and couldn't capture
  reconstruction: {
    turnCount: number
    toolNames: string[]
    toolCallCount: number
    likelyPruned: boolean
    missingSystemPrompt: true
    missingFileContents: boolean
    missingToolSchemas: boolean
  }
}

function buildFingerprint(entries: Array<RawAssistantEntry | RawUserEntry>): SessionFingerprint {
  const humanMessages: string[] = []
  const toolNames = new Set<string>()
  let toolCallCount = 0
  let humanTurnCount = 0
  let hasFileRef = false

  for (const entry of entries) {
    if (entry.type === 'user') {
      const text = extractUserText(entry.message.content)
      if (text) {
        humanTurnCount++
        // Check for @file mentions (heuristic: text includes a file path)
        if (text.match(/[@/~][\w./\\-]{4,}/)) hasFileRef = true
        if (humanMessages.length === 0) {
          humanMessages.push(text.slice(0, MAX_FIRST_MSG))
        } else if (humanMessages.length <= MAX_FOLLOWUPS) {
          humanMessages.push(text.slice(0, MAX_FOLLOWUP))
        }
      }
    }

    if (entry.type === 'assistant') {
      const content = entry.message.content ?? []
      for (const block of content) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          toolNames.add(block.name)
          toolCallCount++
        }
      }
    }
  }

  const toolList = [...toolNames].map(name => ({ name, description: '' }))

  const messages = humanMessages.map(text => ({ role: 'user', content: text }))

  return {
    syntheticInput: { messages, tools: toolList },
    reconstruction: {
      turnCount:           humanTurnCount,
      toolNames:           [...toolNames],
      toolCallCount,
      likelyPruned:        humanTurnCount > PRUNING_THRESHOLD,
      missingSystemPrompt: true,
      missingFileContents: hasFileRef,
      missingToolSchemas:  toolNames.size > 0,
    },
  }
}

// ── Session aggregation ───────────────────────────────────────────────────────

interface SessionData {
  sessionId: string
  projectPath: string
  tool: 'nanoclaw' | 'claude-code'
  primaryModel: string      // most-used model in this session
  firstTimestamp: string
  lastTimestamp: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd: number
  messageCount: number
  compactCount: number
  fingerprint: SessionFingerprint
  rawEntries: Array<RawAssistantEntry | RawUserEntry>
}

function decodeFolderName(name: string): string {
  return '/' + name.replace(/^-/, '').replace(/-/g, '/')
}

function parseSessionFile(
  filePath: string,
  projectPath: string,
): SessionData | null {
  let content: string
  try { content = fs.readFileSync(filePath, 'utf-8') } catch { return null }

  const lines = content.split('\n').filter(l => l.trim())
  const assistantEntries: RawAssistantEntry[] = []
  const userEntries: RawUserEntry[] = []
  const compactTimestamps: string[] = []

  for (const line of lines) {
    let entry: { type?: string; subtype?: string } & Record<string, unknown>
    try { entry = JSON.parse(line) } catch { continue }

    if (entry.type === 'assistant') assistantEntries.push(entry as unknown as RawAssistantEntry)
    if (entry.type === 'user')      userEntries.push(entry as unknown as RawUserEntry)
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      const ts = (entry as unknown as RawSystemEntry).timestamp
      if (ts) compactTimestamps.push(ts)
    }
  }

  if (assistantEntries.length === 0) return null

  // Token/cost totals from assistant entries, accounting for compact boundaries.
  // For each segment of turns before a compact, cache reads are replaced with
  // COMPACT_RESET_TOKENS (the post-compact summary size) instead of their actual
  // (growing) values, since those turns' context was erased by the compact.
  let inputTokens = 0, outputTokens = 0, cacheCreate = 0, cacheRead = 0
  const modelCounts: Record<string, number> = {}
  let firstTimestamp = assistantEntries[0].timestamp ?? ''
  let lastTimestamp  = assistantEntries[assistantEntries.length - 1].timestamp ?? ''

  // Sort compact boundaries ascending
  const sortedCompacts = [...compactTimestamps].sort()

  // Split assistant entries into segments separated by compact boundaries.
  // Each segment except the last contributed a compacted context — substitute
  // its cache_read total with COMPACT_RESET_TOKENS.
  let segmentStart = 0
  for (const compactTs of sortedCompacts) {
    // Find entries in this segment (before this compact boundary)
    let segmentCacheRead = 0
    let nextStart = segmentStart
    for (let i = segmentStart; i < assistantEntries.length; i++) {
      const e = assistantEntries[i]
      if ((e.timestamp ?? '') > compactTs) { nextStart = i; break }
      if (i === assistantEntries.length - 1) nextStart = assistantEntries.length

      const u = e.message.usage ?? {}
      inputTokens  += u.input_tokens  ?? 0
      outputTokens += u.output_tokens ?? 0
      cacheCreate  += u.cache_creation_input_tokens ?? 0
      segmentCacheRead += u.cache_read_input_tokens ?? 0
      const model = e.message.model ?? 'unknown'
      modelCounts[model] = (modelCounts[model] ?? 0) + 1
      if (e.timestamp && e.timestamp < firstTimestamp) firstTimestamp = e.timestamp
      if (e.timestamp && e.timestamp > lastTimestamp)  lastTimestamp  = e.timestamp
    }
    // Replace the entire pre-compact segment's cache reads with the reset amount
    cacheRead += segmentCacheRead > 0 ? COMPACT_RESET_TOKENS : 0
    segmentStart = nextStart
  }

  // Final segment (after last compact, or entire session if no compacts): use actual values
  for (let i = segmentStart; i < assistantEntries.length; i++) {
    const e = assistantEntries[i]
    const u = e.message.usage ?? {}
    inputTokens  += u.input_tokens  ?? 0
    outputTokens += u.output_tokens ?? 0
    cacheCreate  += u.cache_creation_input_tokens ?? 0
    cacheRead    += u.cache_read_input_tokens     ?? 0
    const model = e.message.model ?? 'unknown'
    modelCounts[model] = (modelCounts[model] ?? 0) + 1
    if (e.timestamp && e.timestamp < firstTimestamp) firstTimestamp = e.timestamp
    if (e.timestamp && e.timestamp > lastTimestamp)  lastTimestamp  = e.timestamp
  }

  const primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown'
  const cwd = assistantEntries[0].cwd ?? projectPath
  const tool: 'nanoclaw' | 'claude-code' = cwd.toLowerCase().includes('nanoclaw') ? 'nanoclaw' : 'claude-code'

  const allEntries = [...assistantEntries, ...userEntries].sort(
    (a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''),
  ) as Array<RawAssistantEntry | RawUserEntry>

  return {
    sessionId:           assistantEntries[0].sessionId ?? path.basename(filePath, '.jsonl'),
    projectPath:         cwd,
    tool,
    primaryModel,
    firstTimestamp,
    lastTimestamp,
    inputTokens,
    outputTokens,
    cacheCreationTokens: cacheCreate,
    cacheReadTokens:     cacheRead,
    costUsd:             calcCost(inputTokens, outputTokens, cacheCreate, cacheRead, primaryModel),
    messageCount:        assistantEntries.length,
    compactCount:        compactTimestamps.length,
    fingerprint:         buildFingerprint(allEntries),
    rawEntries:          allEntries,
  }
}

// ── Report types ──────────────────────────────────────────────────────────────

interface SessionReport {
  session_id: string
  project_path: string
  tool: 'nanoclaw' | 'claude-code'
  primary_model: string
  first_timestamp: string
  last_timestamp: string
  tokens: {
    input: number
    output: number
    cache_creation: number
    cache_read: number
  }
  cost_usd: number
  message_count: number
  compact_count: number
  current_quality: number | null
  classification: {
    primary_metric: string | null
    metric_ids: string[]
    task_tier: ModelTier
    scores: Record<string, number>
    classifier_runtime: string
  }
  recommendation: {
    kind: RecommendationKind
    alternative_model: string
    savings_usd: number
    savings_pct: number
    cost_delta_usd: number
    alternative_quality: number | null
    quality_delta: number | null
  } | null
  reconstruction: SessionFingerprint['reconstruction']
}

// ── Main scan ─────────────────────────────────────────────────────────────────

function scan(): object {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects')
  const sessions: SessionData[] = []

  if (!fs.existsSync(claudeProjectsDir)) {
    console.error(`No ~/.claude/projects directory found`)
    return buildReport(sessions)
  }

  for (const folder of fs.readdirSync(claudeProjectsDir)) {
    const folderPath = path.join(claudeProjectsDir, folder)
    if (!fs.statSync(folderPath).isDirectory()) continue
    const decodedPath = decodeFolderName(folder)

    for (const jf of fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'))) {
      const session = parseSessionFile(path.join(folderPath, jf), decodedPath)
      if (session) sessions.push(session)
    }
  }

  return buildReport(sessions)
}

function buildReport(sessions: SessionData[]): object {
  if (sessions.length === 0) {
    return {
      scanned_at: new Date().toISOString(),
      totals: { sessions: 0, messages: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, savingsUsd: 0 },
      sessions: [],
      by_metric: {},
      by_recommendation: {},
      reconstruction_coverage: { sessions_likely_pruned: 0, sessions_missing_file_contents: 0 },
    }
  }

  // ── Classify all sessions in a single batch call ──────────────────────────
  process.stderr.write(`[agent-scan-deep] Classifying ${sessions.length} sessions...\n`)

  let classifierRuntime = 'unknown'
  const classificationResults: Array<{ primary_metric: string | null; metric_ids: string[]; scores: Record<string, number> }> =
    sessions.map(() => ({ primary_metric: null, metric_ids: [], scores: {} }))

  try {
    const texts = sessions.map(s => {
      // extractInputText expects a Record<string, unknown> — our syntheticInput matches
      const msgs = (s.fingerprint.syntheticInput.messages as Array<{ role: string; content: string }>)
      const toolList = s.fingerprint.syntheticInput.tools as Array<{ name: string }>
      const parts: string[] = []
      for (const m of msgs) if (m.content) parts.push(`${m.role}: ${m.content}`)
      if (toolList.length > 0) {
        parts.push('tools:')
        for (const t of toolList.slice(0, 8)) parts.push(`- ${t.name}`)
      }
      return parts.join('\n')
    })

    const output = classifyTexts(texts, {
      cwd: path.join(__dirname, '..', 'input-analysis'),
      pythonPath: PYTHON_BIN,
      forceFallback: true,  // keyword fallback — no torch/transformers required
    })

    classifierRuntime = output.model.runtime_mode ?? 'unknown'

    for (let i = 0; i < output.predictions.length; i++) {
      const p = output.predictions[i]
      classificationResults[i] = {
        primary_metric: p.primary_metric ?? null,
        metric_ids: p.metric_ids,
        scores: p.scores,
      }
    }
    process.stderr.write(`[agent-scan-deep] Classification complete (runtime: ${classifierRuntime})\n`)
  } catch (err) {
    process.stderr.write(`[agent-scan-deep] Classifier failed — continuing without classification: ${err}\n`)
  }

  // ── Load quality scores + pricing for quality-aware recommendations ─────────
  let qualityScores: ReturnType<typeof loadQualityScores> | null = null
  let modelAliases: Record<string, string[]> = {}
  let pricingTable: ReturnType<typeof loadPricingTable> | null = null
  try {
    qualityScores = loadQualityScores()
    modelAliases  = loadModelAliases()
    pricingTable  = loadPricingTable(
      path.join(__dirname, '..', 'estimate', 'pricing', 'models.json'),
      {
        openPricingPath: path.join(__dirname, '..', 'input-analysis', 'pricing', 'models-open.json'),
        includeOpenPricing: true,
      },
    )
  } catch {
    process.stderr.write('[agent-scan-deep] Quality scores/pricing unavailable — quality fields will be null\n')
  }

  const qualityPreferences = resolveQualityPreferences({ preset: 'balanced' })

  // ── Build per-session reports ─────────────────────────────────────────────
  const sessionReports: SessionReport[] = []
  let totalSavings = 0

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]
    const cls = classificationResults[i]

    // Still compute task tier for display purposes
    const taskTier = tierFor(cls.metric_ids)

    // Build metric weights from active metrics (single = direct lookup, multiple = weighted blend)
    const metricWeights: Record<string, number> = {}
    for (const id of cls.metric_ids) metricWeights[id] = Math.max(cls.scores[id] ?? 0.5, 0.1)

    // Per-task quality for current model
    let currentQuality: number | null = null
    if (qualityScores && cls.metric_ids.length > 0) {
      const currentKey = resolveQualityModelId(s.primaryModel, modelAliases, qualityScores)
      if (currentKey) currentQuality = taskQualityScore(currentKey, metricWeights, qualityScores)
    }

    // Recalculate cost using pricing table (includes accurate cache rates)
    if (pricingTable) {
      const modelPricing = getModelPricing(pricingTable, s.primaryModel)
      const cost = calculateCost(s.inputTokens, s.outputTokens, modelPricing, s.cacheCreationTokens, s.cacheReadTokens)
      s.costUsd = cost.total_usd
    }

    // Quality-floor-aware recommendation — same logic as the telemetry pipeline
    let rec: ReturnType<typeof pickBestAlternative> = null
    if (pricingTable && qualityScores && cls.metric_ids.length > 0) {
      rec = pickBestAlternative(
        s.primaryModel,
        'chat_completion',
        s.inputTokens,
        s.outputTokens,
        s.cacheCreationTokens,
        s.cacheReadTokens,
        pricingTable,
        {
          metricWeights,
          scores: qualityScores,
          aliases: modelAliases,
          preferences: qualityPreferences,
        },
      )
    }

    if (rec) totalSavings += rec.savings_usd

    sessionReports.push({
      session_id:      s.sessionId,
      project_path:    s.projectPath,
      tool:            s.tool,
      primary_model:   s.primaryModel,
      first_timestamp: s.firstTimestamp,
      last_timestamp:  s.lastTimestamp,
      tokens: {
        input:         s.inputTokens,
        output:        s.outputTokens,
        cache_creation: s.cacheCreationTokens,
        cache_read:    s.cacheReadTokens,
      },
      cost_usd:      s.costUsd,
      message_count: s.messageCount,
      compact_count: s.compactCount,
      classification: {
        primary_metric:   cls.primary_metric,
        metric_ids:       cls.metric_ids,
        task_tier:        taskTier,
        scores:           cls.scores,
        classifier_runtime: classifierRuntime,
      },
      current_quality: currentQuality,
      recommendation: rec ? {
        kind:              'downgrade',
        alternative_model: rec.alternative_model,
        savings_usd:       rec.savings_usd,
        savings_pct:       rec.savings_percent,
        cost_delta_usd:    rec.savings_usd,
        alternative_quality: rec.alternative_quality,
        quality_delta:     rec.quality_delta,
      } : null,
      reconstruction: s.fingerprint.reconstruction,
    })
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  const totals = {
    sessions:     sessions.length,
    messages:     sessions.reduce((n, s) => n + s.messageCount, 0),
    inputTokens:  sessions.reduce((n, s) => n + s.inputTokens,  0),
    outputTokens: sessions.reduce((n, s) => n + s.outputTokens, 0),
    costUsd:      sessions.reduce((n, s) => n + s.costUsd,      0),
    savingsUsd:   totalSavings,
    savingsPct:   0,
  }
  const totalCost = totals.costUsd
  totals.savingsPct = totalCost > 0 ? Math.round((totalSavings / totalCost) * 100) : 0

  // ── By metric ─────────────────────────────────────────────────────────────
  const byMetric: Record<string, { sessions: number; costUsd: number; savingsUsd: number }> = {}
  for (const sr of sessionReports) {
    const key = sr.classification.primary_metric ?? 'unclassified'
    if (!byMetric[key]) byMetric[key] = { sessions: 0, costUsd: 0, savingsUsd: 0 }
    byMetric[key].sessions  += 1
    byMetric[key].costUsd   += sr.cost_usd
    byMetric[key].savingsUsd += sr.recommendation?.savings_usd ?? 0
  }

  // ── By recommendation ─────────────────────────────────────────────────────
  const byRec: Record<string, { sessions: number; savingsUsd: number }> = {}
  for (const sr of sessionReports) {
    if (!sr.recommendation) continue
    const k = sr.recommendation.alternative_model
    if (!byRec[k]) byRec[k] = { sessions: 0, savingsUsd: 0 }
    byRec[k].sessions  += 1
    byRec[k].savingsUsd += sr.recommendation.savings_usd
  }

  // ── Reconstruction coverage ───────────────────────────────────────────────
  const coverage = {
    sessions_likely_pruned:          sessionReports.filter(s => s.reconstruction.likelyPruned).length,
    sessions_missing_file_contents:  sessionReports.filter(s => s.reconstruction.missingFileContents).length,
    sessions_with_tool_calls:        sessionReports.filter(s => s.reconstruction.toolCallCount > 0).length,
    note: 'All sessions are missing the system prompt. Token counts are exact (from usage field); classification is based on reconstructed input only.',
  }

  return {
    scanned_at: new Date().toISOString(),
    totals,
    sessions: sessionReports.sort((a, b) => b.cost_usd - a.cost_usd),
    by_metric: byMetric,
    by_recommendation: byRec,
    reconstruction_coverage: coverage,
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
  process.stderr.write(`✓ Deep agent scan complete → ${outputPath}\n`)
} else {
  process.stdout.write(json + '\n')
}
