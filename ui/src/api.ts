import type { AppState, FindingsDocument, EstimateReport, AnalyzeInputsReport, NanoclawStatus, QualityPreset } from './types'

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
  return res.json()
}

export function getState(): Promise<AppState> {
  return fetchJSON<AppState>('/api/state')
}

export function validatePath(path: string): Promise<{ valid: boolean; isDirectory: boolean }> {
  return fetchJSON('/api/validate-path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  })
}

export function checkNanoclaw(): Promise<NanoclawStatus> {
  return fetchJSON<NanoclawStatus>('/api/nanoclaw-check')
}

export function startScan(repoPath: string, mode: 'static' | 'full'): Promise<void> {
  return fetchJSON('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath, mode })
  })
}

export function getFindings(): Promise<FindingsDocument> {
  return fetchJSON<FindingsDocument>('/api/findings')
}

export function startEstimate(callsPerMonth?: number): Promise<void> {
  return fetchJSON('/api/estimate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callsPerMonth })
  })
}

export function getEstimate(): Promise<EstimateReport> {
  return fetchJSON<EstimateReport>('/api/estimate')
}

export function startAnalyze(preset: QualityPreset): Promise<void> {
  return fetchJSON('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset })
  })
}

export function getAnalysis(): Promise<AnalyzeInputsReport> {
  return fetchJSON<AnalyzeInputsReport>('/api/analyze')
}

export function createLogsEventSource(): EventSource {
  return new EventSource('/api/logs')
}
