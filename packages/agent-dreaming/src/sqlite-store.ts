import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DreamingCheckpoint, DreamingEvidence, DreamingEvidenceResolver, DreamingExperience, DreamingFeedbackEvent, DreamingMemory, DreamingPage, DreamingProposal, DreamingRelationship, DreamingRepository, DreamingRun } from './index.js';

export interface SqliteDreamingOptions { filename: string; busyTimeoutMs?: number }
export interface AppendExperienceInput extends Omit<DreamingExperience, 'sequence'> { sequence?: number }
export interface ReviewQueueItem {
  proposal: DreamingProposal; evidence: DreamingEvidence[]; runId: string; reason: string;
  status: 'pending' | 'approved' | 'rejected'; createdAt: string; reviewedAt?: string; reviewedBy?: string;
}
type Row = Record<string, any>;
const encode = (v: unknown) => JSON.stringify(v ?? null);
const decode = <T>(v: unknown) => JSON.parse(String(v)) as T;

/** Built-in durable store. Implements both repository and local evidence resolution. */
export class SqliteDreamingStore implements DreamingRepository, DreamingEvidenceResolver {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(options: SqliteDreamingOptions) {
    if (!options.filename?.trim()) throw new TypeError('filename is required');
    if (options.filename !== ':memory:') mkdirSync(path.dirname(path.resolve(options.filename)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(options.filename, { timeout: Math.max(0, Math.min(30000, options.busyTimeoutMs ?? 5000)) });
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS experiences(id TEXT PRIMARY KEY,scope TEXT NOT NULL,sequence INTEGER NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,refs TEXT NOT NULL,metadata TEXT NOT NULL,reviewed_at TEXT,UNIQUE(scope,sequence));' +
      'CREATE INDEX IF NOT EXISTS experiences_scope_seq ON experiences(scope,sequence);' +
      'CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,scope TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,importance REAL NOT NULL,refs TEXT NOT NULL,last_validated_at TEXT,valid_until TEXT,confidence REAL,metadata TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS memories_scope_status ON memories(scope,status,importance DESC);' +
      'CREATE TABLE IF NOT EXISTS relationships(id TEXT PRIMARY KEY,scope TEXT NOT NULL,from_id TEXT NOT NULL,to_id TEXT NOT NULL,kind TEXT NOT NULL,refs TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS evidence(ref TEXT PRIMARY KEY,scope TEXT NOT NULL,content TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT,metadata TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY,scope TEXT NOT NULL,memory_id TEXT NOT NULL,occurred_at TEXT NOT NULL,payload TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS feedback_memory_time ON feedback(scope,memory_id,occurred_at);' +
      'CREATE TABLE IF NOT EXISTS checkpoints(scope TEXT PRIMARY KEY,after_sequence INTEGER NOT NULL,last_run_at TEXT,last_run_id TEXT);' +
      'CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,payload TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS proposals(proposal_id TEXT PRIMARY KEY,scope TEXT NOT NULL,run_id TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,evidence TEXT NOT NULL,created_at TEXT NOT NULL,reviewed_at TEXT,reviewed_by TEXT);' +
      'CREATE INDEX IF NOT EXISTS proposals_scope_status ON proposals(scope,status,created_at);' +
      'CREATE TABLE IF NOT EXISTS applied_proposals(proposal_id TEXT PRIMARY KEY,scope TEXT NOT NULL,applied_at TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS leases(scope TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL);'
    );
    if (options.filename !== ':memory:') { try { chmodSync(options.filename, 0o600); } catch {} }
  }

  async appendExperience(input: AppendExperienceInput): Promise<DreamingExperience> {
    this.ensure();
    this.tx(() => {
      const old=this.db.prepare('SELECT scope FROM experiences WHERE id=?').get(input.id) as Row|undefined;
      if(old){if(old.scope!==input.scope)throw new Error('Experience ID belongs to another scope');return;}
      const seq=input.sequence ?? Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM experiences WHERE scope=?').get(input.scope) as Row).n);
      this.db.prepare('INSERT INTO experiences(id,scope,sequence,content,created_at,refs,metadata) VALUES(?,?,?,?,?,?,?)')
        .run(input.id,input.scope,seq,input.content,input.createdAt,encode(input.sourceRefs),encode(input.metadata ?? {}));
    });
    return this.experience(this.db.prepare('SELECT * FROM experiences WHERE id=?').get(input.id) as Row);
  }
  async upsertMemory(m: DreamingMemory): Promise<void> {
    this.ensure(); const now=new Date().toISOString();
    this.db.prepare('INSERT INTO memories(id,scope,content,status,importance,refs,last_validated_at,valid_until,confidence,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) '+
      'ON CONFLICT(id) DO UPDATE SET content=excluded.content,status=excluded.status,importance=excluded.importance,refs=excluded.refs,last_validated_at=excluded.last_validated_at,valid_until=excluded.valid_until,confidence=excluded.confidence,metadata=excluded.metadata,updated_at=excluded.updated_at WHERE memories.scope=excluded.scope')
      .run(m.id,m.scope,m.content,m.status,m.importance,encode(m.sourceRefs),m.lastValidatedAt ?? null,m.validUntil ?? null,m.confidence ?? null,encode(m.metadata ?? {}),now,now);
  }
  async appendRelationship(r: DreamingRelationship): Promise<void> {
    this.ensure(); this.db.prepare('INSERT OR IGNORE INTO relationships(id,scope,from_id,to_id,kind,refs) VALUES(?,?,?,?,?,?)')
      .run(r.id,r.scope,r.fromId,r.toId,r.kind,encode(r.sourceRefs));
  }
  async putEvidence(scope: string,e: DreamingEvidence): Promise<void> {
    this.ensure(); this.db.prepare('INSERT INTO evidence(ref,scope,content,kind,created_at,metadata) VALUES(?,?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET content=excluded.content,kind=excluded.kind,created_at=excluded.created_at,metadata=excluded.metadata WHERE evidence.scope=excluded.scope')
      .run(e.ref,scope,e.content,e.kind,e.createdAt ?? null,encode(e.metadata ?? {}));
  }
  async resolve(input:{scope:string;refs:readonly string[]}):Promise<readonly DreamingEvidence[]> {
    this.ensure(); if(!input.refs.length)return [];
    const rows=this.db.prepare('SELECT * FROM evidence WHERE scope=? AND ref IN ('+input.refs.map(()=>'?').join(',')+')')
      .all(input.scope,...input.refs) as Row[];
    const map=new Map(rows.map(r=>[String(r.ref),this.evidence(r)]));
    return input.refs.flatMap(ref=>map.has(ref)?[map.get(ref)!]:[]);
  }
  async loadExperiences(i:{scope:string;afterSequence:number;reviewBefore?:string;limit:number}):Promise<DreamingPage<DreamingExperience>> {
    this.ensure(); const rows=this.db.prepare('SELECT * FROM experiences WHERE scope=? AND (sequence>? OR (? IS NOT NULL AND (reviewed_at IS NULL OR reviewed_at<=?))) ORDER BY sequence LIMIT ?')
      .all(i.scope,i.afterSequence,i.reviewBefore ?? null,i.reviewBefore ?? null,i.limit+1) as Row[];
    return {items:rows.slice(0,i.limit).map(r=>this.experience(r)),hasMore:rows.length>i.limit};
  }
  async loadMemories(i:{scope:string;experienceIds:readonly string[];reviewBefore?:string;expiredBefore?:string;limit:number}):Promise<readonly DreamingMemory[]> {
    this.ensure(); const rows=this.db.prepare("SELECT * FROM memories WHERE scope=? AND status IN ('candidate','confirmed') ORDER BY CASE WHEN valid_until IS NOT NULL AND valid_until<=? THEN 0 WHEN last_validated_at IS NULL OR last_validated_at<=? THEN 1 ELSE 2 END,importance DESC,updated_at DESC LIMIT ?")
      .all(i.scope,i.expiredBefore ?? new Date().toISOString(),i.reviewBefore ?? '1970-01-01T00:00:00.000Z',i.limit) as Row[];
    return rows.map(r=>this.memory(r));
  }
  async loadRelationships(i:{scope:string;memoryIds:readonly string[];limit:number}):Promise<readonly DreamingRelationship[]> {
    this.ensure(); if(!i.memoryIds.length)return [];
    const ids=[...i.memoryIds]; const rows=this.db.prepare('SELECT * FROM relationships WHERE scope=? AND (from_id IN ('+ids.map(()=>'?').join(',')+') OR to_id IN ('+ids.map(()=>'?').join(',' )+')) LIMIT ?')
      .all(i.scope,...ids,...ids,i.limit) as Row[];
    return rows.map(r=>({id:String(r.id),scope:String(r.scope),fromId:String(r.from_id),toId:String(r.to_id),kind:String(r.kind),sourceRefs:decode<string[]>(r.refs)}));
  }
  async loadCheckpoint(scope:string):Promise<DreamingCheckpoint> {
    this.ensure(); const r=this.db.prepare('SELECT * FROM checkpoints WHERE scope=?').get(scope) as Row|undefined;
    return r?{scope,afterSequence:Number(r.after_sequence),...(r.last_run_at?{lastRunAt:String(r.last_run_at)}:{}),...(r.last_run_id?{lastRunId:String(r.last_run_id)}:{})}:{scope,afterSequence:0};
  }
  async markExperiencesReviewed(i:{scope:string;ids:readonly string[];reviewedAt:string}):Promise<void> {
    this.ensure(); const s=this.db.prepare('UPDATE experiences SET reviewed_at=? WHERE scope=? AND id=?'); this.tx(()=>{for(const id of i.ids)s.run(i.reviewedAt,i.scope,id);});
  }
  async markMemoriesReviewed(i:{scope:string;ids:readonly string[];reviewedAt:string}):Promise<void> {
    this.ensure(); const s=this.db.prepare('UPDATE memories SET last_validated_at=?,updated_at=? WHERE scope=? AND id=?'); this.tx(()=>{for(const id of i.ids)s.run(i.reviewedAt,i.reviewedAt,i.scope,id);});
  }
  async saveCheckpoint(c:DreamingCheckpoint):Promise<void> {
    this.ensure(); this.db.prepare('INSERT INTO checkpoints(scope,after_sequence,last_run_at,last_run_id) VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET after_sequence=MAX(after_sequence,excluded.after_sequence),last_run_at=excluded.last_run_at,last_run_id=excluded.last_run_id')
      .run(c.scope,c.afterSequence,c.lastRunAt ?? null,c.lastRunId ?? null);
  }
  async createRun(r:DreamingRun):Promise<void> { this.ensure(); this.db.prepare('INSERT INTO runs(id,scope,status,started_at,finished_at,payload) VALUES(?,?,?,?,?,?)').run(r.id,r.scope,r.status,r.startedAt,r.finishedAt ?? null,encode(r)); }
  async updateRun(r:DreamingRun):Promise<void> { this.ensure(); this.db.prepare('UPDATE runs SET status=?,finished_at=?,payload=? WHERE id=? AND scope=?').run(r.status,r.finishedAt ?? null,encode(r),r.id,r.scope); }
  async commitProposal(i:{proposal:DreamingProposal;evidence:readonly DreamingEvidence[];runId:string}):Promise<{applied:boolean;reason?:string}> {
    this.ensure(); const p=i.proposal;
    if(p.operation!=='add'||!p.proposedRecord)return {applied:false,reason:'only-add-can-be-auto-committed'};
    if(p.proposedRecord.scope!==p.scope||!p.proposedRecord.sourceRefs.length)return {applied:false,reason:'invalid-provenance'};
    const refs=new Set(i.evidence.map(e=>e.ref)); if(p.evidenceRefs.some(ref=>!refs.has(ref)))return {applied:false,reason:'unresolved-evidence'};
    return this.tx(()=>{
      if(this.db.prepare('SELECT 1 FROM applied_proposals WHERE proposal_id=?').get(p.id))return {applied:true};
      if(this.db.prepare('SELECT 1 FROM memories WHERE id=?').get(p.proposedRecord!.id))return {applied:false,reason:'memory-id-exists'};
      this.insertMemory(p.proposedRecord!,'candidate');
      for(const rel of p.relationships ?? [])this.db.prepare('INSERT OR IGNORE INTO relationships(id,scope,from_id,to_id,kind,refs) VALUES(?,?,?,?,?,?)').run(rel.id,rel.scope,rel.fromId,rel.toId,rel.kind,encode(rel.sourceRefs));
      this.db.prepare('INSERT INTO applied_proposals(proposal_id,scope,applied_at) VALUES(?,?,?)').run(p.id,p.scope,new Date().toISOString());
      return {applied:true};
    });
  }
  async stageProposal(i:{proposal:DreamingProposal;evidence:readonly DreamingEvidence[];runId:string;reason:'mutation'|'quality-gate'|'conflict-risk'|'missing-assessment'|'missing-provenance'}):Promise<{staged:boolean;reason?:string}> {
    this.ensure(); const r=this.db.prepare("INSERT INTO proposals(proposal_id,scope,run_id,reason,status,payload,evidence,created_at) VALUES(?,?,?,?,'pending',?,?,?) ON CONFLICT(proposal_id) DO NOTHING")
      .run(i.proposal.id,i.proposal.scope,i.runId,i.reason,encode(i.proposal),encode(i.evidence),new Date().toISOString());
    return {staged:Number(r.changes)>0 || Boolean(this.db.prepare("SELECT 1 FROM proposals WHERE proposal_id=? AND status='pending'").get(i.proposal.id))};
  }
  async recordFeedback(e:DreamingFeedbackEvent):Promise<void> {
    this.ensure(); const old=this.db.prepare('SELECT payload FROM feedback WHERE id=?').get(e.id) as Row|undefined;
    if(old){if(String(old.payload)!==encode(e))throw new Error('Conflicting feedback event ID: '+e.id);return;}
    this.db.prepare('INSERT INTO feedback(id,scope,memory_id,occurred_at,payload) VALUES(?,?,?,?,?)').run(e.id,e.scope,e.memoryId,e.occurredAt,encode(e));
  }
  async loadFeedback(i:{scope:string;memoryIds:readonly string[];since:string;limit:number}):Promise<readonly DreamingFeedbackEvent[]> {
    this.ensure(); if(!i.memoryIds.length)return []; const ids=[...i.memoryIds];
    const rows=this.db.prepare('SELECT payload FROM feedback WHERE scope=? AND occurred_at>=? AND memory_id IN ('+ids.map(()=>'?').join(',')+') ORDER BY occurred_at LIMIT ?').all(i.scope,i.since,...ids,i.limit) as Row[];
    return rows.map(r=>decode<DreamingFeedbackEvent>(r.payload));
  }
  async acquireLease(i:{scope:string;owner:string;leaseMs:number}):Promise<boolean> {
    this.ensure(); return this.tx(()=>{const now=Date.now();const old=this.db.prepare('SELECT owner,expires_at FROM leases WHERE scope=?').get(i.scope) as Row|undefined;
      if(old&&Number(old.expires_at)>now&&old.owner!==i.owner)return false;
      this.db.prepare('INSERT INTO leases(scope,owner,expires_at) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at').run(i.scope,i.owner,now+i.leaseMs);return true;});
  }
  async renewLease(i:{scope:string;owner:string;leaseMs:number}):Promise<boolean> {
    this.ensure(); const r=this.db.prepare('UPDATE leases SET expires_at=? WHERE scope=? AND owner=? AND expires_at>?').run(Date.now()+i.leaseMs,i.scope,i.owner,Date.now());return Number(r.changes)===1;
  }
  async releaseLease(i:{scope:string;owner:string}):Promise<void> { this.ensure();this.db.prepare('DELETE FROM leases WHERE scope=? AND owner=?').run(i.scope,i.owner); }
  async listReviewQueue(i:{scope:string;status?:ReviewQueueItem['status'];limit?:number}):Promise<ReviewQueueItem[]> {
    this.ensure();const n=Math.max(1,Math.min(500,Math.floor(i.limit??100)));const sql='SELECT * FROM proposals WHERE scope=? '+(i.status?'AND status=? ':'')+'ORDER BY created_at DESC LIMIT ?';
    const rows=(i.status?this.db.prepare(sql).all(i.scope,i.status,n):this.db.prepare(sql).all(i.scope,n)) as Row[];
    return rows.map(r=>({proposal:decode<DreamingProposal>(r.payload),evidence:decode<DreamingEvidence[]>(r.evidence),runId:String(r.run_id),reason:String(r.reason),status:r.status,createdAt:String(r.created_at),...(r.reviewed_at?{reviewedAt:String(r.reviewed_at)}:{}),...(r.reviewed_by?{reviewedBy:String(r.reviewed_by)}:{})}));
  }
  async resolveReview(i:{scope:string;proposalId:string;decision:'approve'|'reject';reviewedBy:string}):Promise<ReviewQueueItem['status']> {
    this.ensure();if(!i.reviewedBy.trim())throw new Error('reviewedBy is required');
    return this.tx(()=>{const r=this.db.prepare('SELECT * FROM proposals WHERE proposal_id=? AND scope=?').get(i.proposalId,i.scope) as Row|undefined;if(!r)throw new Error('Review proposal not found');if(r.status!=='pending')return r.status;
      const p=decode<DreamingProposal>(r.payload);if(i.decision==='approve')this.applyReviewed(p);
      const status=i.decision==='approve'?'approved':'rejected';this.db.prepare('UPDATE proposals SET status=?,reviewed_at=?,reviewed_by=? WHERE proposal_id=? AND status=?').run(status,new Date().toISOString(),i.reviewedBy,i.proposalId,'pending');return status;});
  }
  async listMemories(scope:string,limit=200):Promise<DreamingMemory[]> {
    this.ensure();return (this.db.prepare('SELECT * FROM memories WHERE scope=? ORDER BY updated_at DESC LIMIT ?').all(scope,Math.max(1,Math.min(1000,limit))) as Row[]).map(r=>this.memory(r));
  }
  async close():Promise<void>{if(!this.closed){this.closed=true;this.db.close();}}
  private ensure(){if(this.closed)throw new Error('SQLite store is closed');}
  private tx<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  private insertMemory(m:DreamingMemory,status:DreamingMemory['status']){const n=new Date().toISOString();this.db.prepare('INSERT INTO memories(id,scope,content,status,importance,refs,last_validated_at,valid_until,confidence,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(m.id,m.scope,m.content,status,m.importance,encode(m.sourceRefs),m.lastValidatedAt??null,m.validUntil??null,m.confidence??null,encode(m.metadata??{}),n,n);}
  private applyReviewed(p:DreamingProposal){
    const targets=p.targetRecordIds.map(id=>this.db.prepare('SELECT * FROM memories WHERE id=? AND scope=?').get(id,p.scope) as Row|undefined);
    if(targets.some(x=>!x))throw new Error('Review target missing or outside scope');
    if(p.operation==='archive'){for(const id of p.targetRecordIds)this.db.prepare("UPDATE memories SET status='archived',updated_at=? WHERE id=? AND scope=?").run(new Date().toISOString(),id,p.scope);return;}
    if(p.proposedRecord){this.insertMemory(p.proposedRecord,'confirmed');if(p.operation!=='add')for(const id of p.targetRecordIds)this.db.prepare("UPDATE memories SET status='superseded',updated_at=? WHERE id=? AND scope=?").run(new Date().toISOString(),id,p.scope);return;}
    throw new Error('Unsupported reviewed proposal');
  }
  private experience(r:Row):DreamingExperience{return {id:String(r.id),scope:String(r.scope),sequence:Number(r.sequence),content:String(r.content),createdAt:String(r.created_at),sourceRefs:decode<string[]>(r.refs),metadata:decode<Record<string,unknown>>(r.metadata)};}
  private memory(r:Row):DreamingMemory{return {id:String(r.id),scope:String(r.scope),content:String(r.content),status:r.status,importance:Number(r.importance),sourceRefs:decode<string[]>(r.refs),...(r.last_validated_at?{lastValidatedAt:String(r.last_validated_at)}:{}),...(r.valid_until?{validUntil:String(r.valid_until)}:{}),...(r.confidence!==null?{confidence:Number(r.confidence)}:{}),metadata:decode<Record<string,unknown>>(r.metadata)};}
  private evidence(r:Row):DreamingEvidence{return {ref:String(r.ref),content:String(r.content),kind:String(r.kind),...(r.created_at?{createdAt:String(r.created_at)}:{}),metadata:decode<Record<string,unknown>>(r.metadata)};}
}
