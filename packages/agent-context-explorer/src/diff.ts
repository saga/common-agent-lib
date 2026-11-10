import type { ContextDiff, ContextMessage, MessageChange } from './model.js';
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value as object).sort().map((key) => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value) ?? String(value);
}
/** Index-based diff preserves conversation order and makes insertions/deletions explicit. */
export function diffContext(before: readonly ContextMessage[], after: readonly ContextMessage[]): ContextDiff {
  const changes: MessageChange[] = [];
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    const left = before[index]; const right = after[index];
    if (!left && right) changes.push({ index, kind: 'added', after: right });
    else if (left && !right) changes.push({ index, kind: 'removed', before: left });
    else if (left && right) {
      const fields = (['role', 'name', 'recipient', 'channel', 'parts', 'metadata'] as const).filter((field) => stable(left[field]) !== stable(right[field]));
      changes.push({ index, kind: fields.length ? 'changed' : 'unchanged', before: left, after: right, ...(fields.length ? { changedFields: fields } : {}) });
    }
  }
  return { added: changes.filter((x) => x.kind === 'added').length, removed: changes.filter((x) => x.kind === 'removed').length, changed: changes.filter((x) => x.kind === 'changed').length, unchanged: changes.filter((x) => x.kind === 'unchanged').length, changes };
}
