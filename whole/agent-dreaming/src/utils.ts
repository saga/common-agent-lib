export function unique(values: string[]): string[] { return [...new Set(values)]; }

export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}
