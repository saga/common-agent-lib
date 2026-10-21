/**
 * Accept only non-empty translations for IDs expected in the current batch.
 * Unknown IDs, malformed entries, blank text and duplicate IDs are ignored.
 */
export function normalizeDocumentBatchResult(
  entries: unknown,
  expectedIds: readonly string[],
): Map<string, string> {
  const expected = new Set(expectedIds);
  const result = new Map<string, string>();
  if (!Array.isArray(entries)) return result;

  for (const entry of entries as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const id: unknown = entry[0];
    const translated: unknown = entry[1];
    if (typeof id !== 'string' || !expected.has(id)) continue;
    if (typeof translated !== 'string' || !translated.trim()) continue;
    if (result.has(id)) continue;
    result.set(id, translated);
  }
  return result;
}

export function getMissingDocumentBatchIds(
  expectedIds: readonly string[],
  translations: ReadonlyMap<string, string>,
): string[] {
  return expectedIds.filter((id) => !translations.get(id)?.trim());
}
