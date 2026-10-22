export interface CodeBuddyContextWindowModel {
  maxInputTokens?: unknown;
  contextWindow?: {
    supportedLengths?: unknown;
    defaultLength?: unknown;
  };
}

export interface NormalizedCodeBuddyContextWindow {
  maxInputTokens: number;
  supportedLengths: number[];
  defaultLength: number;
}

export interface CodeBuddyContextWindowOption {
  type: 'select';
  id: 'context_window';
  name: 'Context window';
  description: string;
  currentValue: string;
  options: Array<{ value: string; name: string }>;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function formatCodeBuddyContextWindow(tokens: number): string {
  if (Number.isSafeInteger(tokens) && tokens > 0 && tokens % 1_000_000 === 0) {
    return String(tokens / 1_000_000) + 'M';
  }
  if (Number.isSafeInteger(tokens) && tokens > 0 && tokens % 1_000 === 0) {
    return String(tokens / 1_000) + 'K';
  }
  return tokens.toLocaleString('en-US') + ' tokens';
}

/**
 * Read the model-side context budget configuration.
 * Invalid/missing maxInputTokens, less than two distinct tiers, non-integer tiers,
 * or any tier above the physical cap means there is no selector.
 */
export function normalizeCodeBuddyContextWindow(
  model: CodeBuddyContextWindowModel | null | undefined,
): NormalizedCodeBuddyContextWindow | undefined {
  const maxInputTokens = positiveInteger(model?.maxInputTokens);
  const rawLengths = model?.contextWindow && typeof model.contextWindow === 'object'
    ? model.contextWindow.supportedLengths
    : undefined;
  if (!maxInputTokens || !Array.isArray(rawLengths)) return undefined;

  const supportedLengths = rawLengths.map(positiveInteger);
  if (supportedLengths.some((value) => value === undefined)) return undefined;
  const lengths = [...new Set(supportedLengths as number[])].sort((a, b) => a - b);
  if (lengths.length < 2 || lengths.some((length) => length > maxInputTokens)) return undefined;

  const configuredDefault = positiveInteger(model?.contextWindow?.defaultLength);
  const defaultLength = configuredDefault !== undefined && lengths.includes(configuredDefault)
    ? configuredDefault
    : lengths[0]!;
  return { maxInputTokens, supportedLengths: lengths, defaultLength };
}

export function resolveCodeBuddyContextWindow(
  model: CodeBuddyContextWindowModel | null | undefined,
  requested: unknown,
): number | undefined {
  const config = normalizeCodeBuddyContextWindow(model);
  const value = positiveInteger(requested);
  if (!config || value === undefined || !config.supportedLengths.includes(value) || value > config.maxInputTokens) {
    return undefined;
  }
  return value;
}

export function buildCodeBuddyContextWindowOption(
  model: CodeBuddyContextWindowModel | null | undefined,
  currentValue?: unknown,
): CodeBuddyContextWindowOption | undefined {
  const config = normalizeCodeBuddyContextWindow(model);
  if (!config) return undefined;
  const requested = resolveCodeBuddyContextWindow(model, currentValue);
  const selected = requested ?? config.defaultLength;
  return {
    type: 'select',
    id: 'context_window',
    name: 'Context window',
    description: 'Select the context budget for this model. The model input-token limit remains unchanged.',
    currentValue: String(selected),
    options: config.supportedLengths.map((tokens) => ({
      value: String(tokens),
      name: formatCodeBuddyContextWindow(tokens),
    })),
  };
}
