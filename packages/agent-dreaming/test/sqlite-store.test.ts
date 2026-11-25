import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteDreamingStore } from '../src/sqlite-store.js';

const setup=()=>{const dir=mkdtempSync(path.join(os.tmpdir(),'dreaming-'));const store=new SqliteDreamingStore({filename:path.join(dir,'db.sqlite')});return {dir,store,close:async()=>{await store.close();rmSync(dir,{recursive:true,force:true});}};};
test('persists experience, evidence, memory, feedback and checkpoint across reopen',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'dreaming-'));const file=path.join(dir,'db.sqlite');
 let s=new SqliteDreamingStore({filename:file});
 await s.appendExperience({id:'e1',scope:'s',content:'fact',createdAt:'2026-01-01T00:00:00.000Z',sourceRefs:['r1']});
 await s.putEvidence('s',{ref:'r1',kind:'note',content:'source'});
 await s.upsertMemory({id:'m1',scope:'s',content:'memory',status:'candidate',importance:.8,sourceRefs:['r1']});
 const event={id:'f1',scope:'s',memoryId:'m1',kind:'retrieval' as const,outcome:'useful' as const,occurredAt:'2026-01-02T00:00:00.000Z'};
 await s.recordFeedback(event);await s.saveCheckpoint({scope:'s',afterSequence:1});await s.close();
 s=new SqliteDreamingStore({filename:file});
 assert.equal((await s.loadExperiences({scope:'s',afterSequence:0,limit:10})).items[0]?.id,'e1');
 assert.equal((await s.resolve({scope:'s',refs:['r1']}))[0]?.content,'source');
 assert.equal((await s.listMemories('s'))[0]?.id,'m1');
 assert.deepEqual(await s.loadFeedback({scope:'s',memoryIds:['m1'],since:'2026-01-01',limit:10}),[event]);
 assert.equal((await s.loadCheckpoint('s')).afterSequence,1);
 await s.close();rmSync(dir,{recursive:true,force:true});
});
test('lease acquisition is exclusive and owner checked',async()=>{
 const x=setup();try{
  assert.equal(await x.store.acquireLease({scope:'s',owner:'a',leaseMs:60000}),true);
  assert.equal(await x.store.acquireLease({scope:'s',owner:'b',leaseMs:60000}),false);
  assert.equal(await x.store.renewLease({scope:'s',owner:'b',leaseMs:60000}),false);
  await x.store.releaseLease({scope:'s',owner:'a'});
  assert.equal(await x.store.acquireLease({scope:'s',owner:'b',leaseMs:60000}),true);
 }finally{await x.close();}
});
test('review queue is durable, idempotent and only applies on approval',async()=>{
 const x=setup();try{
  const proposal={id:'p1',scope:'s',operation:'add' as const,targetRecordIds:[],proposedRecord:{id:'m2',scope:'s',content:'new',status:'candidate' as const,importance:.5,sourceRefs:['r1']},rationale:'source supports',evidenceRefs:['r1']};
  await x.store.stageProposal({proposal,evidence:[{ref:'r1',content:'evidence',kind:'note'}],runId:'run1',reason:'quality-gate'});
  await x.store.stageProposal({proposal,evidence:[],runId:'run1',reason:'quality-gate'});
  assert.equal((await x.store.listReviewQueue({scope:'s'})).length,1);
  assert.equal((await x.store.listMemories('s')).length,0);
  assert.equal(await x.store.resolveReview({scope:'s',proposalId:'p1',decision:'approve',reviewedBy:'reviewer'}),'approved');
  assert.equal((await x.store.listMemories('s'))[0]?.status,'confirmed');
 }finally{await x.close();}
});
test('feedback event IDs are idempotent and conflicting reuse is rejected',async()=>{
 const x=setup();try{
  const event={id:'f1',scope:'s',memoryId:'m1',kind:'retrieval' as const,outcome:'useful' as const,occurredAt:'2026-01-01T00:00:00.000Z'};
  await x.store.recordFeedback(event);await x.store.recordFeedback(event);
  await assert.rejects(()=>x.store.recordFeedback({...event,outcome:'not-useful'}),/Conflicting/);
 }finally{await x.close();}
});
