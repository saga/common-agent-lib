export interface StateDefinition { id:string; terminal?:boolean; }
export interface TransitionDefinition { from:string; event:string; to:string; }
export interface StateMachineDefinition { id:string; initial:string; states:StateDefinition[]; transitions:TransitionDefinition[]; }
export interface StateChange<TContext> { from:string; event:string; to:string; context:TContext; }

/** 只负责确定性状态转移，不执行业务动作。 */
export class StateMachine<TContext=unknown> {
  private currentStateId:string;
  constructor(public readonly definition:StateMachineDefinition, private readonly context:TContext) {
    if(!definition.states.some(state=>state.id===definition.initial)) throw new Error('初始状态不存在：'+definition.initial);
    this.currentStateId=definition.initial;
  }
  get state():StateDefinition {
    const state=this.definition.states.find(item=>item.id===this.currentStateId);
    if(!state) throw new Error('当前状态不存在：'+this.currentStateId);
    return state;
  }
  can(event:string):boolean { return this.definition.transitions.some(item=>item.from===this.currentStateId && item.event===event); }
  transition(event:string):StateChange<TContext> {
    if(this.state.terminal) throw new Error('状态机已经结束：'+this.currentStateId);
    const transition=this.definition.transitions.find(item=>item.from===this.currentStateId && item.event===event);
    if(!transition) throw new Error('当前状态 '+this.currentStateId+' 不允许事件 '+event);
    if(!this.definition.states.some(state=>state.id===transition.to)) throw new Error('状态转移目标不存在：'+transition.to);
    const change={from:this.currentStateId,event,to:transition.to,context:this.context};
    this.currentStateId=transition.to;
    return change;
  }
}

export function validateStateMachine(definition:StateMachineDefinition):string[] {
  const issues:string[]=[];
  const ids=new Set<string>();
  if(!definition.id.trim()) issues.push('状态机 id 不能为空。');
  if(!definition.states.length) issues.push('状态机至少需要一个状态。');
  if(!definition.states.some(state=>state.id===definition.initial)) issues.push('initial 指向不存在的状态：'+definition.initial);
  for(const state of definition.states){if(ids.has(state.id)) issues.push('重复状态：'+state.id);ids.add(state.id);}
  for(const transition of definition.transitions){if(!ids.has(transition.from)) issues.push('转移来源不存在：'+transition.from);if(!ids.has(transition.to)) issues.push('状态转移目标不存在：'+transition.to);}
  return issues;
}