import { createHash } from 'node:crypto';
import type { DreamingMemory, DreamingUserDirectiveInput } from '../types.js';
import type { SqliteDatabase } from './database.js';
import { encode, mapMemory, type SqliteRow } from './database.js';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Writes explicit user instructions directly as protected, confirmed memories. */
export class SqliteUserDirectiveStore {
  constructor(private readonly context: SqliteDatabase) {}

  async applyUserDirective(input: DreamingUserDirectiveInput): Promise<DreamingMemory> {
    this.context.ensureOpen();
    if (!input.id?.trim() || !input.scope?.trim() || !input.instruction?.trim()) {
      throw new TypeError('User directive id, scope and instruction are required.');
    }
    if (input.id.length > 500 || input.instruction.length > 2_000) {
      throw new TypeError('User directive exceeds the supported length.');
    }
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(occurredAt))) {
      throw new TypeError('User directive occurredAt must be a valid timestamp.');
    }
    if (input.origin && !input.origin.system?.trim()) {
      throw new TypeError('User directive origin.system must be a non-empty string.');
    }

    const instruction = input.instruction.trim().normalize('NFKC');
    const normalized = instruction.toLocaleLowerCase().replace(/\s+/gu, ' ');
    const memoryId = `user-directive-${hash(`${input.scope}\0${input.kind}\0${normalized}`)}`;
    const sourceRef = `user-directive:${hash(`${input.scope}\0${input.id}`)}`;
    const content = input.kind === 'avoid'
      ? `Avoid repeating this behavior: ${instruction}`
      : instruction;
    const memoryType = input.memoryType ?? (input.kind === 'avoid' ? 'constraint' : 'fact');
    const payload = encode({
      ...input,
      instruction,
      occurredAt,
      memoryType,
      sourceRef,
    });

    return this.context.transaction(() => {
      const previousDirective = this.context.db.prepare(
        'SELECT scope,memory_id,payload FROM user_directives WHERE id=?',
      ).get(input.id) as SqliteRow | undefined;
      if (previousDirective) {
        if (previousDirective.scope !== input.scope || String(previousDirective.payload) !== payload) {
          throw new Error('Conflicting user directive ID: ' + input.id);
        }
        const row = this.context.db.prepare(
          'SELECT * FROM memories WHERE id=? AND scope=?',
        ).get(memoryId, input.scope) as SqliteRow | undefined;
        if (!row) throw new Error('Applied user directive memory is missing: ' + memoryId);
        return mapMemory(row);
      }

      const oldEvidence = this.context.db.prepare(
        'SELECT scope,content,kind,origin FROM evidence WHERE ref=?',
      ).get(sourceRef) as SqliteRow | undefined;
      if (oldEvidence) {
        const same = oldEvidence.scope === input.scope
          && oldEvidence.content === instruction
          && oldEvidence.kind === 'user-directive'
          && (oldEvidence.origin == null
            ? input.origin === undefined
            : String(oldEvidence.origin) === encode(input.origin));
        if (!same) throw new Error('Conflicting user directive evidence reference: ' + sourceRef);
      } else {
        this.context.db.prepare(
          'INSERT INTO evidence(ref,scope,content,kind,created_at,metadata,origin) VALUES(?,?,?,?,?,?,?)',
        ).run(
          sourceRef,
          input.scope,
          instruction,
          'user-directive',
          occurredAt,
          encode({ directiveKind: input.kind }),
          input.origin ? encode(input.origin) : null,
        );
      }

      const oldMemory = this.context.db.prepare(
        'SELECT * FROM memories WHERE id=?',
      ).get(memoryId) as SqliteRow | undefined;
      if (oldMemory && oldMemory.scope !== input.scope) {
        throw new Error('User directive memory ID belongs to another scope: ' + memoryId);
      }

      const sourceRefs = oldMemory
        ? [...new Set([...(JSON.parse(String(oldMemory.refs)) as string[]), sourceRef])]
        : [sourceRef];
      const metadata = oldMemory
        ? JSON.parse(String(oldMemory.metadata)) as Record<string, unknown>
        : {};
      const nextMetadata = {
        ...metadata,
        directiveKind: input.kind,
        lastExplicitDirectiveAt: occurredAt,
      };

      if (oldMemory) {
        this.context.db.prepare(
          'INSERT INTO memory_versions(scope,memory_id,version,reason,captured_at,payload) ' +
          'SELECT scope,id,(SELECT COALESCE(MAX(version),0)+1 FROM memory_versions WHERE scope=? AND memory_id=?),' +
          '?, ?, json_object(' +
          "'id',id,'scope',scope,'content',content,'status',status,'importance',importance,'sourceRefs',refs," +
          "'memoryType',memory_type,'authority',authority,'metadata',metadata" +
          ') FROM memories WHERE id=? AND scope=?',
        ).run(input.scope, memoryId, 'user-explicit-directive', occurredAt, memoryId, input.scope);

        this.context.db.prepare(
          'UPDATE memories SET content=?,status=?,importance=?,refs=?,last_validated_at=?,confidence=?,' +
          'metadata=?,updated_at=?,memory_type=?,authority=? WHERE id=? AND scope=?',
        ).run(
          content, 'confirmed', 1, encode(sourceRefs), occurredAt, 1,
          encode(nextMetadata), occurredAt, memoryType, 'user-explicit', memoryId, input.scope,
        );
      } else {
        this.context.db.prepare(
          'INSERT INTO memories(id,scope,content,status,importance,refs,last_validated_at,valid_until,' +
          'confidence,metadata,created_at,updated_at,memory_type,authority) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          memoryId, input.scope, content, 'confirmed', 1, encode(sourceRefs), occurredAt, null,
          1, encode(nextMetadata), occurredAt, occurredAt, memoryType, 'user-explicit',
        );
      }

      this.context.db.prepare(
        'INSERT INTO user_directives(id,scope,memory_id,source_ref,occurred_at,payload) VALUES(?,?,?,?,?,?)',
      ).run(input.id, input.scope, memoryId, sourceRef, occurredAt, payload);

      const row = this.context.db.prepare(
        'SELECT * FROM memories WHERE id=? AND scope=?',
      ).get(memoryId, input.scope) as SqliteRow;
      return mapMemory(row);
    });
  }
}
