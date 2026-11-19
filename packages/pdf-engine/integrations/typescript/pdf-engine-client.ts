import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

type JsonObject = Record<string, unknown>;

interface WorkerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { type: string; message: string };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

/**
 * Minimal TypeScript host adapter for the Python JSONL worker.
 * Install saga-pdf-engine into the selected Python environment first.
 */
export class PdfEngineClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(options: {
    workspace: string;
    python?: string;
    onStderr?: (chunk: string) => void;
    requestTimeoutMs?: number;
  }) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.child = spawn(
      options.python ?? 'python',
      ['-m', 'pdf_engine.server', '--workspace', options.workspace],
      { stdio: ['pipe', 'pipe', 'pipe'], shell: false },
    );

    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => options.onStderr?.(chunk));
    this.child.on('error', (error) => this.failAll(error));
    this.child.on('close', (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`PDF worker exited (code=${code}, signal=${signal})`));
    });
  }

  private readonly requestTimeoutMs: number;

  async request<T>(method: string, params: JsonObject = {}): Promise<T> {
    if (this.closed || !this.child.stdin.writable) {
      throw new Error('PDF worker is not running.');
    }

    const id = randomUUID();
    const response = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`PDF request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
    });

    try {
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) clearTimeout(pending.timeout);
      this.pending.delete(id);
      throw error;
    }
    return response;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      this.child.once('close', () => resolve());
    });
  }

  kill(): void {
    if (!this.closed) this.child.kill();
  }

  private handleLine(line: string): void {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch {
      this.failAll(new Error('PDF worker returned invalid JSON.'));
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);

    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error?.message ?? 'PDF operation failed.'));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
