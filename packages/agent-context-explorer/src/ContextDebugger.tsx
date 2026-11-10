import React, { useMemo, useState } from 'react';
import { Alert, Card, Collapse, Descriptions, Empty, List, Progress, Space, Statistic, Table, Tabs, Tag, Timeline, Tree, Typography } from 'antd';
import { Bubble } from '@ant-design/x';
import type { ContextCompaction, ContextEvent, ContextMessage, ContextRun, ContextSession, ContextSnapshot, ContentPart, ToolCallNode } from './model.js';
import { analyzeCompaction, buildContextTimeline, buildToolCallGraph } from './session.js';
import { diffContext } from './diff.js';

const { Text, Paragraph } = Typography;
type DataNode = { key: string; title: React.ReactNode; children?: DataNode[] };
const json = (value: unknown): string => { try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); } };
function PartView({ part }: { part: ContentPart }) {
  if (part.kind === 'text') return <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{part.text}</Paragraph>;
  if (part.kind === 'thinking') return <Collapse size="small" items={[{ key: 'thinking', label: 'Thinking / reasoning block', children: <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{part.text}</pre> }]} />;
  if (part.kind === 'image') return <Space direction="vertical"><Text type="secondary">Image · {part.mediaType ?? 'unknown media type'}{part.detail ? ' · ' + part.detail : ''}</Text>{part.url?.startsWith('http') ? <img src={part.url} alt={part.alt ?? 'Prompt image'} style={{ maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} /> : <Text code>{part.url ? '[inline image data]' : '[image payload not rendered]'}</Text>}</Space>;
  if (part.kind === 'tool-call') return <Card size="small" title={<Space><Tag color="blue">Tool call</Tag><Text strong>{part.name}</Text></Space>}><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{json(part.arguments)}</pre></Card>;
  if (part.kind === 'tool-result') return <Card size="small" title={<Space><Tag color={part.isError ? 'red' : 'green'}>Tool result</Tag><Text>{part.name ?? part.toolCallId ?? 'Tool output'}</Text></Space>}><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{json(part.content)}</pre></Card>;
  if (part.kind === 'refusal') return <Alert type="warning" showIcon message="Refusal" description={part.text} />;
  return <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{json(part.kind === 'json' ? part.value : part.kind === 'unknown' ? part.value : part)}</pre>;
}
function MessageView({ message }: { message: ContextMessage }) {
  const placement = message.role === 'user' ? 'end' : 'start';
  const label = [message.role, message.name, message.channel].filter(Boolean).join(' · ');
  return <Bubble placement={placement} variant="outlined" shape="round" header={<Space size={6}><Tag color={message.role === 'user' ? 'blue' : message.role === 'assistant' ? 'purple' : 'default'}>{label}</Tag><Text type="secondary" style={{ fontSize: 11 }}>#{message.index + 1}</Text></Space>} content={<Space direction="vertical" size="middle" style={{ width: '100%' }}>{message.parts.length ? message.parts.map((part, index) => <PartView key={index} part={part} />) : <Text type="secondary">Empty message</Text>}{message.recipient && <Text type="secondary">To: {message.recipient}</Text>}</Space>} />;
}
function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return <Card size="small" title={title}><Paragraph copyable={{ text: json(value) }}><Text type="secondary">Copy JSON</Text></Paragraph><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 480, overflow: 'auto', margin: 0 }}>{json(value)}</pre></Card>;
}
function ToolTree({ nodes, roots }: { nodes: ToolCallNode[]; roots: string[] }) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  for (const node of nodes) if (node.parentToolCallId && byId.has(node.parentToolCallId)) children.set(node.parentToolCallId, [...(children.get(node.parentToolCallId) ?? []), node.id]);
  const makeNode = (id: string, visited = new Set<string>()): DataNode => {
    const node = byId.get(id)!;
    if (visited.has(id)) return { key: id, title: id + ' (cycle)' };
    const next = new Set(visited); next.add(id);
    const color = node.status === 'completed' ? 'green' : node.status === 'failed' ? 'red' : 'orange';
    return { key: id, title: <Space wrap><Text strong>{node.name}</Text><Tag color={color}>{node.status}</Tag><Text type="secondary">{id}</Text>{node.durationMs !== undefined && <Text type="secondary">{node.durationMs} ms</Text>}</Space>, children: (children.get(id) ?? []).map((child) => makeNode(child, next)) };
  };
  return roots.map((id) => makeNode(id));
}
function ToolDetails({ nodes }: { nodes: ToolCallNode[] }) {
  const [selected, setSelected] = useState<string>();
  const node = nodes.find((item) => item.id === selected);
  return <Space direction="vertical" style={{ display: 'flex' }}>
    {nodes.length ? <Tree showLine defaultExpandAll treeData={ToolTree({ nodes, roots: nodes.filter((n) => !n.parentToolCallId || !nodes.some((x) => x.id === n.parentToolCallId)).map((n) => n.id) })} onSelect={(keys) => setSelected(String(keys[0] ?? ''))} /> : <Empty description="No tool calls captured" />}
    {node && <Card size="small" title={node.name}><Descriptions size="small" column={1} items={[{ key: 'id', label: 'Call ID', children: node.id }, { key: 'status', label: 'Status', children: node.status }, { key: 'duration', label: 'Duration', children: node.durationMs === undefined ? '—' : node.durationMs + ' ms' }, { key: 'agent', label: 'Agent', children: node.agentId ?? '—' }, { key: 'MCP server', label: 'MCP server', children: node.mcpServerName ?? '—' }, { key: 'MCP tool', label: 'MCP tool', children: node.mcpToolName ?? '—' }]} /><JsonPanel title="Arguments" value={node.arguments} />{node.progress.length > 0 && <List size="small" header="Progress" dataSource={node.progress} renderItem={(item) => <List.Item>{item.timestamp} · {String(item.message ?? json(item.data))}</List.Item>} />}{node.result !== undefined && <JsonPanel title="Result" value={node.result} />}</Card>}
  </Space>;
}
function CompactionView({ item }: { item: ContextCompaction }) {
  const analysis = analyzeCompaction(item);
  return <Card size="small" title={<Space><Tag color="purple">Compaction</Tag>{item.strategy ?? 'Context transformation'}</Space>} extra={<Text type="secondary">{new Date(item.timestamp).toLocaleString()}</Text>}>
    {item.reason && <Paragraph>{item.reason}</Paragraph>}{item.error && <Alert type="error" showIcon message="Compaction failed" description={item.error} />}
    <Space wrap size="large">
      <Statistic title="Messages before" value={item.before.messages.length} />
      <Statistic title="Messages after" value={item.after.messages.length} />
      <Statistic title="Removed" value={analysis.removedMessageIds.length} />
      <Statistic title="Preserved" value={analysis.preservedMessageIds.length} />
      {analysis.beforeTokens !== undefined && <Statistic title="Input tokens before" value={analysis.beforeTokens} />}
      {analysis.afterTokens !== undefined && <Statistic title="Input tokens after" value={analysis.afterTokens} />}{item.messagesRemoved !== undefined && <Statistic title="Reported messages removed" value={item.messagesRemoved} />}{item.tokensRemoved !== undefined && <Statistic title="Reported tokens removed" value={item.tokensRemoved} />}
    </Space>
    {analysis.tokenReduction !== undefined && <div style={{ marginTop: 12 }}><Text type="secondary">Token reduction: {analysis.tokenReduction.toLocaleString()} ({analysis.tokenReductionPercent?.toFixed(1)}%)</Text><Progress percent={Math.max(0, Math.min(100, analysis.tokenReductionPercent ?? 0))} /></div>}
    {item.summary && <Card size="small" title="Compaction summary" style={{ marginTop: 12 }}><Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{item.summary}</Paragraph></Card>}
    <Collapse style={{ marginTop: 12 }} items={[
      { key: 'removed', label: 'Removed message IDs (' + analysis.removedMessageIds.length + ')', children: <List size="small" dataSource={analysis.removedMessageIds} renderItem={(id) => <List.Item>{id}</List.Item>} /> },
      { key: 'preserved', label: 'Preserved message IDs (' + analysis.preservedMessageIds.length + ')', children: <List size="small" dataSource={analysis.preservedMessageIds} renderItem={(id) => <List.Item>{id}</List.Item>} /> },
      { key: 'diff', label: 'Before / after message diff', children: <Table size="small" rowKey="index" pagination={{ pageSize: 8 }} dataSource={analysis.diff.changes} columns={[
        { title: '#', dataIndex: 'index', render: (value: number) => value + 1 },
        { title: 'Change', dataIndex: 'kind', render: (value: string) => <Tag color={value === 'removed' ? 'red' : value === 'added' ? 'green' : value === 'changed' ? 'orange' : 'default'}>{value}</Tag> },
        { title: 'Fields', dataIndex: 'changedFields', render: (value?: string[]) => value?.join(', ') ?? '—' },
        { title: 'Message', render: (_: unknown, row: (typeof analysis.diff.changes)[number]) => <Text ellipsis style={{ maxWidth: 360 }}>{(row.after ?? row.before)?.parts.map((p) => p.kind === 'text' ? p.text : '[' + p.kind + ']').join(' ')}</Text> },
      ]} /> },
    ]} />
  </Card>;
}
export interface ContextDebuggerProps {
  snapshot?: ContextSnapshot; previous?: ContextSnapshot; session?: ContextSession;
  className?: string;
}
/** Session-level debugger: LLM call timeline, correlated tool execution graph and compaction analysis. */
export function ContextDebugger({ snapshot, previous, session, className }: ContextDebuggerProps) {
  const [activeKey, setActiveKey] = useState('timeline');
  const selected = snapshot ?? (session ? [...session.runs].sort((a, b) => b.sequence - a.sequence)[0]?.snapshot : undefined);
  const runs: ContextRun[] = session?.runs ?? (selected ? [{ id: selected.id, sequence: 1, startedAt: selected.createdAt ?? new Date(0).toISOString(), status: 'completed', snapshot: selected }] : []);
  const events: ContextEvent[] = session?.events ?? [];
  const compactions = session?.compactions ?? [];
  const timeline = useMemo(() => buildContextTimeline({ runs, events, compactions }), [runs, events, compactions]);
  const allMessages = runs.flatMap((run) => [...run.snapshot.messages, ...run.snapshot.responseMessages]);
  const toolGraph = useMemo(() => buildToolCallGraph(allMessages, events), [allMessages, events]);
  const contextDiff = previous && selected ? diffContext(previous.messages, selected.messages) : undefined;
  const totalInput = runs.reduce((sum, run) => sum + (run.usage?.inputTokens ?? run.inputTokens ?? run.snapshot.usage?.inputTokens ?? 0), 0);
  const totalOutput = runs.reduce((sum, run) => sum + (run.usage?.outputTokens ?? run.outputTokens ?? run.snapshot.usage?.outputTokens ?? 0), 0);
  if (!selected && !session) return <Empty description="Provide a ContextSnapshot or ContextSession" />;
  const tabs = [
    { key: 'timeline', label: <>Timeline <Tag>{timeline.length}</Tag></>, children: timeline.length ? <Timeline items={timeline.map((item) => ({ key: item.id, color: item.status === 'failed' ? 'red' : item.type === 'compaction' ? 'purple' : item.type.startsWith('tool') ? 'green' : 'blue', children: <Space direction="vertical" size={2}><Space wrap><Text strong>{item.title}</Text><Tag>{item.type}</Tag>{item.status && <Tag color={item.status === 'failed' ? 'red' : item.status === 'completed' ? 'green' : 'default'}>{item.status}</Tag>}{item.durationMs !== undefined && <Text type="secondary">{item.durationMs} ms</Text>}</Space><Text type="secondary">{new Date(item.timestamp).toLocaleString()}{item.description ? ' · ' + item.description : ''}</Text></Space> }))} /> : <Empty description="No session events or model calls captured" /> },
    { key: 'tools', label: <>Tool chain <Tag>{toolGraph.nodes.length}</Tag></>, children: <ToolDetails nodes={toolGraph.nodes} /> },
    { key: 'compaction', label: <>Compaction <Tag>{compactions.length}</Tag></>, children: compactions.length ? <Space direction="vertical" style={{ display: 'flex' }}>{compactions.map((item) => <CompactionView key={item.id} item={item} />)}</Space> : <Empty description="No compaction snapshots captured" /> },
    { key: 'runs', label: <>LLM calls <Tag>{runs.length}</Tag></>, children: runs.length ? <Table size="small" rowKey="id" dataSource={runs} pagination={{ pageSize: 10 }} columns={[
      { title: '#', dataIndex: 'sequence' }, { title: 'Provider', render: (_: unknown, run: ContextRun) => run.provider ?? run.snapshot.provider }, { title: 'Model', render: (_: unknown, run: ContextRun) => run.actualModel ?? run.snapshot.model ?? run.model ?? '—' },
      { title: 'Status', dataIndex: 'status', render: (value: string) => <Tag color={value === 'failed' ? 'red' : value === 'completed' ? 'green' : 'processing'}>{value}</Tag> },
      { title: 'Input', render: (_: unknown, run: ContextRun) => run.usage?.inputTokens ?? run.inputTokens ?? run.snapshot.usage?.inputTokens ?? '—' },
      { title: 'Output', render: (_: unknown, run: ContextRun) => run.usage?.outputTokens ?? run.outputTokens ?? run.snapshot.usage?.outputTokens ?? '—' }, { title: 'Cached', render: (_: unknown, run: ContextRun) => run.usage?.cachedInputTokens ?? run.snapshot.usage?.cachedInputTokens ?? '—' }, { title: 'Reasoning', render: (_: unknown, run: ContextRun) => run.usage?.reasoningTokens ?? run.snapshot.usage?.reasoningTokens ?? '—' }, { title: 'Context', render: (_: unknown, run: ContextRun) => run.contextUsage?.percent === undefined ? '—' : run.contextUsage.percent + '%' }, { title: 'TTFT', render: (_: unknown, run: ContextRun) => run.usage?.timeToFirstTokenMs === undefined ? '—' : run.usage.timeToFirstTokenMs + ' ms' }, { title: 'Cost', render: (_: unknown, run: ContextRun) => run.usage?.premiumRequestCost !== undefined ? run.usage.premiumRequestCost : run.usage?.totalNanoAiu !== undefined ? run.usage.totalNanoAiu + ' nAIU' : '—' },
      { title: 'Messages', render: (_: unknown, run: ContextRun) => run.snapshot.messages.length },
      { title: 'Started', dataIndex: 'startedAt', render: (value: string) => new Date(value).toLocaleString() },
    ]} /> : <Empty description="No LLM calls captured" /> },
    ...(selected ? [{ key: 'context', label: 'Latest context', children: <Space direction="vertical" style={{ display: 'flex' }}>
      {selected.system && <Card size="small" title="System context"><Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{selected.system}</Paragraph></Card>}
      {[...selected.messages, ...selected.responseMessages].map((message) => <MessageView key={message.id} message={message} />)}
      <JsonPanel title="Request parameters" value={selected.parameters} />
    </Space> }] : []),
    ...(contextDiff ? [{ key: 'diff', label: <>Context diff <Tag>+{contextDiff.added} / −{contextDiff.removed} / ~{contextDiff.changed}</Tag></>, children: <Table size="small" rowKey="index" dataSource={contextDiff.changes} columns={[
      { title: '#', dataIndex: 'index', render: (value: number) => value + 1 }, { title: 'Change', dataIndex: 'kind', render: (value: string) => <Tag>{value}</Tag> },
      { title: 'Fields', dataIndex: 'changedFields', render: (value?: string[]) => value?.join(', ') ?? '—' },
      { title: 'Message', render: (_: unknown, row: (typeof contextDiff.changes)[number]) => <Text ellipsis>{(row.after ?? row.before)?.parts.map((p) => p.kind === 'text' ? p.text : '[' + p.kind + ']').join(' ')}</Text> },
    ]} /> }] : []),
  ];
  return <div className={className}>
    <Card size="small">
      <Space wrap size="large">
        {session && <Statistic title="Session" value={session.id} />}
        <Statistic title="LLM calls" value={runs.length} />
        <Statistic title="Tool calls" value={toolGraph.nodes.length} />
        <Statistic title="Compactions" value={compactions.length} />
        <Statistic title="Input tokens" value={totalInput} />
        <Statistic title="Output tokens" value={totalOutput} />
      </Space>
    </Card>
    {toolGraph.orphanResults.length > 0 && <Alert style={{ marginTop: 8 }} type="warning" showIcon message={toolGraph.orphanResults.length + ' tool result(s) could not be correlated to a captured tool call.'} />}
    <Tabs activeKey={activeKey} onChange={setActiveKey} items={tabs} style={{ marginTop: 12 }} />
  </div>;
}
