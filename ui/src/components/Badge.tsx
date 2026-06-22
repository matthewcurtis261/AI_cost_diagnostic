interface ProviderBadgeProps { provider: string }
interface ConfidenceBadgeProps { confidence: 'high' | 'medium' | 'low' }
interface StatusBadgeProps { status: 'idle' | 'running' | 'done' | 'error' }
interface CallTypeBadgeProps { callType: string }

export function ProviderBadge({ provider }: ProviderBadgeProps) {
  const p = provider.toLowerCase()
  let cls = 'badge--gray'
  let dotColor = '#9ca3af'
  let label = provider

  if (p.includes('openai')) { cls = 'badge--blue'; dotColor = '#2563eb'; label = 'OpenAI' }
  else if (p.includes('anthropic')) { cls = 'badge--orange'; dotColor = '#c2410c'; label = 'Anthropic' }
  else if (p.includes('google')) { cls = 'badge--green'; dotColor = '#16a34a'; label = 'Google' }
  else if (p.includes('cohere')) { cls = 'badge--gray'; dotColor = '#6b7280'; label = 'Cohere' }

  return (
    <span className={`badge ${cls}`}>
      <span className="badge-dot" style={{ background: dotColor }} />
      {label}
    </span>
  )
}

export function ConfidenceBadge({ confidence }: ConfidenceBadgeProps) {
  const map = {
    high: { cls: 'badge--green', label: 'Verified' },
    medium: { cls: 'badge--yellow', label: 'Likely' },
    low: { cls: 'badge--gray', label: 'Possible' },
  }
  const { cls, label } = map[confidence] ?? map.low
  return <span className={`badge ${cls}`}>{label}</span>
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const map = {
    idle: { cls: 'badge--gray', label: 'Idle' },
    running: { cls: 'badge--blue', label: 'Running' },
    done: { cls: 'badge--green', label: 'Done' },
    error: { cls: 'badge--red', label: 'Error' },
  }
  const { cls, label } = map[status] ?? map.idle
  return <span className={`badge ${cls}`}>{label}</span>
}

export function CallTypeBadge({ callType }: CallTypeBadgeProps) {
  const map: Record<string, string> = {
    chat_completion: 'Chat',
    embedding: 'Embedding',
    image: 'Image',
    speech: 'Speech',
    agent_framework: 'Agent',
  }
  const label = map[callType] ?? callType
  return <span className="badge badge--gray">{label}</span>
}
