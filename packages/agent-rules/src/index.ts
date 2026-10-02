import * as z from 'zod';
export const RuleOperatorSchema = z.enum(['eq','neq','gt','gte','lt','lte','in','notIn','contains','exists']);
export type RuleOperator = z.infer<typeof RuleOperatorSchema>;
export const RulePredicateSchema = z.object({ fact:z.string().min(1), op:RuleOperatorSchema, value:z.unknown().optional() }).strict();
export type RulePredicate = z.infer<typeof RulePredicateSchema>;
export type RuleCondition = { all: RuleCondition[] } | { any: RuleCondition[] } | { not: RuleCondition } | { predicate: RulePredicate };
const RuleConditionSchema: z.ZodType<RuleCondition> = z.lazy(() => z.union([
  z.object({all:z.array(RuleConditionSchema).min(1)}).strict(),
  z.object({any:z.array(RuleConditionSchema).min(1)}).strict(),
  z.object({not:RuleConditionSchema}).strict(),
  z.object({predicate:RulePredicateSchema}).strict(),
]));
export const RuleSchema = z.object({id:z.string().min(1),version:z.number().int().positive(),enabled:z.boolean().default(true),priority:z.number().int().default(0),when:RuleConditionSchema,output:z.unknown(),stop:z.boolean().default(false)}).strict();
export type Rule<TOutput=unknown> = z.infer<typeof RuleSchema> & { output:TOutput };
export interface MatchedRule<TOutput> { ruleId:string; version:number; output:TOutput; }

function readPath(input:unknown, path:string):unknown {
  let current=input;
  for(const part of path.split('.')) {
    if(current===null || current===undefined || typeof current!=='object') return undefined;
    current=(current as Record<string,unknown>)[part];
  }
  return current;
}

function compare(value:unknown, op:RuleOperator, expected:unknown):boolean {
  if(op==='eq') return value===expected;
  if(op==='neq') return value!==expected;
  if(op==='gt') return typeof value==='number' && typeof expected==='number' && value>expected;
  if(op==='gte') return typeof value==='number' && typeof expected==='number' && value>=expected;
  if(op==='lt') return typeof value==='number' && typeof expected==='number' && value<expected;
  if(op==='lte') return typeof value==='number' && typeof expected==='number' && value<=expected;
  if(op==='in') return Array.isArray(expected) && expected.some(item=>item===value);
  if(op==='notIn') return Array.isArray(expected) && !expected.some(item=>item===value);
  if(op==='contains') return Array.isArray(value) ? value.some(item=>item===expected) : typeof value==='string' && typeof expected==='string' ? value.includes(expected) : false;
  return value!==undefined && value!==null;
}

function matches(condition:RuleCondition, context:unknown):boolean {
  if('predicate' in condition) return compare(readPath(context,condition.predicate.fact),condition.predicate.op,condition.predicate.value);
  if('all' in condition) return condition.all.every(item=>matches(item,context));
  if('any' in condition) return condition.any.some(item=>matches(item,context));
  return !matches(condition.not,context);
}

/** 纯确定性规则评估器：同一 facts + 同一规则集合得到相同结果。 */
export function evaluateRules<TContext,TOutput=unknown>(context:TContext,rules:Rule<TOutput>[]):MatchedRule<TOutput>[] {
  const parsed=rules.map(rule=>RuleSchema.parse(rule) as Rule<TOutput>);
  const matched:MatchedRule<TOutput>[]=[];
  for(const rule of parsed.filter(item=>item.enabled).sort((a,b)=>b.priority-a.priority)) {
    if(!matches(rule.when,context)) continue;
    matched.push({ruleId:rule.id,version:rule.version,output:rule.output});
    if(rule.stop) break;
  }
  return matched;
}

/** 用 facts 替换 {{path}}，用于 title、recommendation 等用户可见文案。 */
export function renderTemplate(template:string,context:unknown):string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g,(_whole,path:string)=>{
    const value=readPath(context,path.trim());
    return value===undefined || value===null ? '' : String(value);
  });
}