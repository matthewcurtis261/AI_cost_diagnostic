/** Keys that must never appear in persisted telemetry (output / completion bodies). */
export const FORBIDDEN_KEYS = new Set([
  'output',
  'output_text',
  'output_content',
  'completion',
  'completion_text',
  'response_content',
  'response_text',
  'choices',
  'content',
  'text',
  'result',
  'answer',
]);

export class ForbiddenOutputFieldError extends Error {
  constructor(public readonly path: string) {
    super(`Telemetry event must not contain output field at ${path}`);
    this.name = 'ForbiddenOutputFieldError';
  }
}

/**
 * Deep-check an object tree for forbidden output-content keys.
 * Allows `content` inside `messages` arrays (request input), but rejects
 * top-level or response-shaped fields.
 */
export function assertNoOutputFields(
  value: unknown,
  path = 'root',
  inMessages = false,
): void {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    const nextInMessages = inMessages || path.endsWith('.messages');
    value.forEach((item, i) => assertNoOutputFields(item, `${path}[${i}]`, nextInMessages));
    return;
  }

  if (typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;

    if (FORBIDDEN_KEYS.has(key)) {
      // `content` is allowed on message objects inside input.messages
      if (key === 'content' && inMessages) {
        assertNoOutputFields(child, childPath, true);
        continue;
      }
      if (key === 'text' && inMessages) {
        assertNoOutputFields(child, childPath, true);
        continue;
      }
      throw new ForbiddenOutputFieldError(childPath);
    }

    assertNoOutputFields(child, childPath, inMessages || key === 'messages');
  }
}

/** Clone request params, keeping only serializable input fields. */
export function cloneInput(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value ?? {})) as Record<string, unknown>;
}
