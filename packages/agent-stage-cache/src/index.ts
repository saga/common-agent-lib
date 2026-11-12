import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export type StageCacheStatus = 'executed' | 'cache_hit';

export interface StageCacheEntry {
  fingerprintHash: string;
  outputFile: string;
  outputHash: string;
  completedAt: string;
}

export interface StageCacheManifest {
  schemaVersion: 1;
  stages: Record<string, StageCacheEntry>;
}

export interface StageCacheResult {
  status: StageCacheStatus;
  output: string;
  stageId: string;
  fingerprintHash: string;
  outputHash: string;
  completedAt: string;
}

export interface RunCachedStageInput {
  /** Directory owned by one logical workflow run. */
  runDir: string;
  /** Stable stage identity. It is not a display label. */
  stageId: string;
  /** Relative path to the materialized stage output. Absolute paths and traversal are rejected. */
  outputFile: string;
  /** Exact, deterministic input/config serialization. Include prompt, system prompt, model and schema versions. */
  fingerprint: string;
  execute: () => Promise<string>;
  /** Validate both cached and freshly generated output. Async validators are supported. */
  validate?: (output: string) => void | Promise<void>;
  /** Maximum time to wait for another process executing the same stage. Defaults to 30 minutes. */
  lockTimeoutMs?: number;
  /** A lock from another host is considered stale after this duration. Defaults to 24 hours. */
  staleLockMs?: number;
}

export class StageCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageCacheError';
  }
}

const DEFAULT_LOCK_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_STALE_LOCK_MS = 24 * 60 * 60 * 1000;
const LOCK_POLL_MS = 40;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeName(value: string): string {
  const name = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) {
    throw new StageCacheError('stageId must be 1-128 characters using letters, numbers, dot, underscore or hyphen.');
  }
  if (name === 'constructor' || name === 'prototype' || name === '__proto__') {
    throw new StageCacheError('stageId uses a reserved object property name.');
  }
  return name;
}

function resolveOutputPath(runDir: string, outputFile: string): string {
  if (!outputFile.trim() || path.isAbsolute(outputFile)) {
    throw new StageCacheError('outputFile must be a non-empty relative path.');
  }
  const root = path.resolve(runDir);
  const output = path.resolve(root, outputFile);
  if (!output.startsWith(root + path.sep)) {
    throw new StageCacheError('outputFile must stay inside runDir.');
  }
  return output;
}

async function atomicWrite(filename: string, content: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = path.join(
    path.dirname(filename),
    '.' + path.basename(filename) + '.' + process.pid + '.' + randomUUID() + '.tmp',
  );
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

interface LockOwner {
  pid: number;
  host: string;
  createdAt: string;
}

async function isStaleLock(lockPath: string, staleLockMs: number): Promise<boolean> {
  try {
    const [raw, info] = await Promise.all([
      readFile(lockPath, 'utf8').catch(() => ''),
      stat(lockPath),
    ]);
    let owner: Partial<LockOwner> = {};
    try { owner = JSON.parse(raw) as Partial<LockOwner>; } catch { /* malformed lock: age still applies */ }
    const age = Math.max(0, Date.now() - info.mtimeMs);
    if (owner.host === hostname() && Number.isInteger(owner.pid) && (owner.pid ?? 0) > 0) {
      try {
        process.kill(owner.pid!, 0);
        return false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM') return false;
        if (code === 'ESRCH') return true;
        return false;
      }
    }
    return age >= staleLockMs;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Exclusive lock file used for short manifest updates and one stage execution.
 * Same-host live PIDs are never expired based only on age; this matters for long LLM calls.
 * Cross-host locks use a conservative age lease and are not a distributed lock service.
 */
async function withFileLock<T>(
  lockPath: string,
  task: () => Promise<T>,
  options: { timeoutMs: number; staleLockMs: number },
): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + options.timeoutMs;
  let ownLockContent = '';

  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      created = true;
      const owner: LockOwner = { pid: process.pid, host: hostname(), createdAt: new Date().toISOString() };
      ownLockContent = JSON.stringify(owner) + '\\n';
      await handle.writeFile(ownLockContent, 'utf8');
      await handle.close();
      handle = undefined;
      break;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (created) await rm(lockPath, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await isStaleLock(lockPath, options.staleLockMs)) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new StageCacheError('Timed out waiting for stage-cache lock: ' + lockPath);
      }
      await delay(LOCK_POLL_MS);
    }
  }

  try {
    return await task();
  } finally {
    const current = await readFile(lockPath, 'utf8').catch(() => '');
    if (current === ownLockContent) await rm(lockPath, { force: true });
  }
}
async function readManifest(filename: string): Promise<StageCacheManifest> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filename, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new StageCacheError('Invalid stage-cache manifest.');
    const value = parsed as Partial<StageCacheManifest>;
    if (value.schemaVersion !== 1 || !value.stages || typeof value.stages !== 'object' || Array.isArray(value.stages)) {
      throw new StageCacheError('Unsupported stage-cache manifest schema.');
    }
    return value as StageCacheManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, stages: {} };
    throw error;
  }
}

async function updateManifest(
  filename: string,
  stageId: string,
  entry: StageCacheEntry,
  lockOptions: { timeoutMs: number; staleLockMs: number },
): Promise<void> {
  await withFileLock(filename + '.lock', async () => {
    const manifest = await readManifest(filename);
    manifest.stages[stageId] = entry;
    await atomicWrite(filename, JSON.stringify(manifest, null, 2) + '\n');
  }, lockOptions);
}

async function recordEvent(filename: string, event: Record<string, unknown>): Promise<void> {
  await appendFile(filename, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
}

async function validateOutput(validator: RunCachedStageInput['validate'], output: string): Promise<void> {
  if (validator) await validator(output);
}

/**
 * Deterministic file-backed stage cache.
 *
 * A per-stage lock prevents duplicate execution of the same stage across local processes.
 * A separate manifest lock protects concurrent completions of different stages. Cache entries
 * are reusable only when both the exact caller-supplied fingerprint and output SHA-256 match,
 * and the caller's semantic validator accepts the cached output.
 */
export async function runCachedStage(input: RunCachedStageInput): Promise<StageCacheResult> {
  if (!input.runDir.trim()) throw new StageCacheError('runDir must not be empty.');
  if (!input.stageId.trim()) throw new StageCacheError('stageId must not be empty.');
  if (typeof input.fingerprint !== 'string') throw new StageCacheError('fingerprint must be a string.');
  if (typeof input.execute !== 'function') throw new StageCacheError('execute must be a function.');

  const runDir = path.resolve(input.runDir);
  const stageId = safeName(input.stageId);
  const outputPath = resolveOutputPath(runDir, input.outputFile);
  const outputFile = path.relative(runDir, outputPath);
  const fingerprintHash = sha256(input.fingerprint);
  const manifestPath = path.join(runDir, 'pipeline-manifest.json');
  const eventsPath = path.join(runDir, 'stage-events.jsonl');
  const fingerprintPath = path.join(runDir, 'stage-' + stageId + '.input.txt');
  const lockOptions = {
    timeoutMs: Math.max(1, Math.floor(input.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)),
    staleLockMs: Math.max(1, Math.floor(input.staleLockMs ?? DEFAULT_STALE_LOCK_MS)),
  };

  await mkdir(runDir, { recursive: true });
  return withFileLock(
    path.join(runDir, '.stage-cache-locks', stageId + '.lock'),
    async () => {
      await atomicWrite(fingerprintPath, input.fingerprint);
      const event = async (status: string, details: Record<string, unknown> = {}) => {
        await recordEvent(eventsPath, {
          at: new Date().toISOString(),
          stage: input.stageId,
          status,
          inputHash: fingerprintHash,
          outputFile,
          ...details,
        });
      };

      const manifest = await readManifest(manifestPath);
      const previous = manifest.stages[input.stageId] ?? manifest.stages[stageId];
      if (previous && previous.fingerprintHash === fingerprintHash && previous.outputFile === outputFile) {
        try {
          const cached = await readFile(outputPath, 'utf8');
          if (sha256(cached) === previous.outputHash && cached.trim()) {
            const value = cached.trimEnd();
            try {
              await validateOutput(input.validate, value);
              await event('cache_hit', { outputHash: previous.outputHash, cachedAt: previous.completedAt });
              return {
                status: 'cache_hit',
                output: value,
                stageId: input.stageId,
                fingerprintHash,
                outputHash: previous.outputHash,
                completedAt: previous.completedAt,
              };
            } catch (error) {
              await event('cache_invalid', { error: error instanceof Error ? error.message : String(error) });
            }
          } else {
            await event('cache_corrupt', { expectedOutputHash: previous.outputHash, actualOutputHash: sha256(cached) });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await event('cache_missing');
        }
      } else {
        await event('cache_miss', { previousInputHash: previous?.fingerprintHash ?? null });
      }

      await event('started');
      try {
        const generated = (await input.execute()).trim();
        if (!generated) throw new StageCacheError('Stage ' + input.stageId + ' returned empty output; it was not checkpointed.');
        await validateOutput(input.validate, generated);
        const output = generated + '\n';
        await atomicWrite(outputPath, output);
        const outputHash = sha256(output);
        const completedAt = new Date().toISOString();
        await updateManifest(manifestPath, input.stageId, {
          fingerprintHash,
          outputFile,
          outputHash,
          completedAt,
        }, lockOptions);
        await event('completed', { outputHash, completedAt, outputChars: generated.length });
        return {
          status: 'executed',
          output: generated,
          stageId: input.stageId,
          fingerprintHash,
          outputHash,
          completedAt,
        };
      } catch (error) {
        await event('failed', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
    lockOptions,
  );
}
