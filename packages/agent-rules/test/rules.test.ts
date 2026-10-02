import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateRules, renderTemplate, type Rule } from '../src/index.js';
type Context={coverage:{lineage:number;parseFailures:number}};
const rules:Rule<{title:string}>[]=[
 {id:'lineage-low',version:1,enabled:true,priority:20,when:{predicate:{fact:'coverage.lineage',op:'lt',value:0.8}},output:{title:'补齐血缘'},stop:false},
 {id:'parse-failure',version:1,enabled:true,priority:10,when:{predicate:{fact:'coverage.parseFailures',op:'gt',value:0}},output:{title:'处理解析失败'},stop:false},
];
test('规则按条件和优先级确定性匹配',()=>{const context:Context={coverage:{lineage:0.7,parseFailures:2}};assert.deepEqual(evaluateRules(context,rules).map(item=>item.ruleId),['lineage-low','parse-failure']);});
test('规则输出可以引用 facts 生成用户可读文案',()=>{assert.equal(renderTemplate('当前血缘覆盖率只有 {{coverage.lineage}}。',{coverage:{lineage:0.73}}),'当前血缘覆盖率只有 0.73。');});