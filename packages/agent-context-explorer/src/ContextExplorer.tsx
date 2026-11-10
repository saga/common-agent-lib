import React, { useMemo, useState } from 'react';
import type { ContextMessage, ContextSnapshot, ContentPart } from './model.js';
import { diffContext } from './diff.js';
export interface ContextExplorerProps { snapshot: ContextSnapshot; previous?: ContextSnapshot; className?: string }
const css: Record<string, React.CSSProperties> = {
  root: { fontFamily: 'ui-sans-serif,system-ui,sans-serif', color: 'var(--context-fg,#20242b)', border: '1px solid var(--context-border,#d8dde5)', borderRadius: 10, overflow: 'hidden', background: 'var(--context-bg,#fff)' },
  row: { borderBottom: '1px solid var(--context-border,#e8ebf0)', padding: 12 }, muted: { color: 'var(--context-muted,#667085)', fontSize: 12 },
  button: { border: '1px solid var(--context-border,#d8dde5)', borderRadius: 6, padding: '5px 10px', background: 'transparent', cursor: 'pointer', color: 'inherit' },
  pre: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '8px 0 0', font: '12px/1.55 ui-monospace,monospace' },
  badge: { display: 'inline-block', borderRadius: 5, padding: '2px 6px', background: 'var(--context-selected,#edf2f8)', fontSize: 11, marginRight: 6 },
};
function partText(p: ContentPart): string {
  if (p.kind === 'text' || p.kind === 'thinking' || p.kind === 'refusal') return p.text;
  if (p.kind === 'tool-call') return JSON.stringify({ name: p.name, arguments: p.arguments }, null, 2);
  if (p.kind === 'tool-result') return typeof p.content === 'string' ? p.content : JSON.stringify(p.content, null, 2);
  if (p.kind === 'image') return p.url ? '[Image] ' + p.url : '[Image payload]';
  if (p.kind === 'json') return JSON.stringify(p.value, null, 2);
  return JSON.stringify(p.value, null, 2);
}
function MessageCard({ message }: { message: ContextMessage }) {
  const [expanded, setExpanded] = useState(false);
  return <article style={css.row}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <div><span style={css.badge}>{message.role}</span>{message.name && <span style={css.muted}>{message.name}</span>}{message.channel && <span style={css.muted}> · {message.channel}</span>}</div>
      <button type="button" style={css.button} onClick={() => setExpanded(!expanded)}>{expanded ? 'Collapse' : 'Raw message'}</button>
    </div>
    {message.parts.map((part, i) => <div key={i} style={{ marginTop: 8 }}><span style={css.badge}>{part.kind}</span><pre style={css.pre}>{partText(part)}</pre></div>)}
    {expanded && <pre style={css.pre}>{JSON.stringify(message.raw, null, 2)}</pre>}
  </article>;
}
/** Compact, framework-light inspector. Hosts may theme it through --context-* CSS variables. */
export function ContextExplorer({ snapshot, previous, className }: ContextExplorerProps) {
  const [tab, setTab] = useState('messages');
  const diff = useMemo(() => previous ? diffContext(previous.messages, snapshot.messages) : undefined, [previous, snapshot]);
  const tabs = ['messages', 'tools', 'parameters', 'raw', ...(previous ? ['diff'] : [])];
  return <section className={className} style={css.root}>
    <header style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--context-border,#d8dde5)' }}>
      <strong>{snapshot.model ?? 'LLM request'}</strong><span style={css.muted}>{snapshot.provider}</span><span style={css.muted}>{snapshot.messages.length} messages</span>
      {snapshot.usage && <span style={css.muted}>{snapshot.usage.inputTokens ?? '—'} in / {snapshot.usage.outputTokens ?? '—'} out tokens</span>}
    </header>
    <nav aria-label="Context views" style={{ display: 'flex', gap: 6, padding: 8, borderBottom: '1px solid var(--context-border,#d8dde5)' }}>
      {tabs.map((item) => <button key={item} type="button" style={{ ...css.button, ...(tab === item ? { background: 'var(--context-selected,#edf2f8)', fontWeight: 600 } : {}) }} onClick={() => setTab(item)}>{item}{item === 'diff' && diff ? ' (+' + diff.added + ' / −' + diff.removed + ' / ~' + diff.changed + ')' : ''}</button>)}
    </nav>
    {snapshot.warnings.map((warning) => <div key={warning} style={{ padding: 10, ...css.muted }}>{warning}</div>)}
    {tab === 'messages' && <>{snapshot.system && <div style={css.row}><strong>System context</strong><pre style={css.pre}>{snapshot.system}</pre></div>}{snapshot.messages.map((m) => <MessageCard key={m.id} message={m} />)}{snapshot.responseMessages.length > 0 && <div style={css.row}><strong>Model response</strong></div>}{snapshot.responseMessages.map((m) => <MessageCard key={m.id} message={m} />)}</>}
    {tab === 'tools' && snapshot.tools.map((tool) => <div key={tool.name} style={css.row}><strong>{tool.name}</strong><p style={css.muted}>{tool.description}</p><pre style={css.pre}>{JSON.stringify(tool.inputSchema ?? tool.raw, null, 2)}</pre></div>)}
    {tab === 'parameters' && <pre style={{ ...css.pre, padding: 16 }}>{JSON.stringify(snapshot.parameters, null, 2)}</pre>}
    {tab === 'raw' && <div style={{ padding: 12 }}><strong>Request</strong><pre style={css.pre}>{JSON.stringify(snapshot.rawRequest, null, 2)}</pre>{snapshot.rawResponse !== undefined && <><strong>Response</strong><pre style={css.pre}>{JSON.stringify(snapshot.rawResponse, null, 2)}</pre></>}</div>}
    {tab === 'diff' && diff && diff.changes.map((change) => <div key={change.index} style={css.row}><span style={css.badge}>{change.kind}</span><strong>Message {change.index + 1}</strong>{change.changedFields && <span style={css.muted}> · {change.changedFields.join(', ')}</span>}<pre style={css.pre}>{JSON.stringify(change.after ?? change.before, null, 2)}</pre></div>)}
  </section>;
}
