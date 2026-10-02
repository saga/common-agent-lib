import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StateMachine, validateStateMachine } from '../src/index.js';

test('确定性状态转移',()=>{
 const machine=new StateMachine({id:'turn',initial:'executing',states:[{id:'executing'},{id:'completed',terminal:true}],transitions:[{from:'executing',event:'complete',to:'completed'}]},{turnId:'turn-1'});
 assert.equal(machine.can('complete'),true);
 assert.equal(machine.transition('complete').to,'completed');
 assert.equal(machine.state.terminal,true);
});
test('非法状态转移被拒绝',()=>{
 assert.deepEqual(validateStateMachine({id:'x',initial:'a',states:[{id:'a'},{id:'b'}],transitions:[{from:'a',event:'go',to:'missing'}]}),['状态转移目标不存在：missing']);
});