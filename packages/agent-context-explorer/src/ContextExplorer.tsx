import React, { useMemo, useState } from 'react';
import { Alert, Card, Collapse, Descriptions, Empty, Space, Tabs, Tag, Typography } from 'antd';
import { Bubble } from '@ant-design/x';
import type { ContextMessage, ContextSnapshot, ContentPart } from './model.js';
import { diffContext } from './diff.js';

const { Text, Paragraph } = Typography;
const json = (value: unknown): string => {
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
};
function PartView({ part }: { part: ContentPart }) {
  if (part.kind === 'text') return <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{part.text}</Paragraph>;
  if (part.kind === 'thinking') return <Collapse size="small" items={[{ key: 'thinking', label: 'Thinking / reasoning block', children: <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{part.text}</pre> }]} />;
  if (part.kind === 'image') return <Space direction="vertical"><Text type="secondary">Image · {part.mediaType ?? 'unknown media type'}{part.detail ? ' · ' + part.detail : ''}</Text>{part.url?.startsWith('http') ? <img src={part.url} alt={part.alt ?? 'Prompt image'} style={{ maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} /> : <Text code>{part.url ? '[inline image data]' : '[image payload not rendered]'}</Text>}</Space>;
  if (part.kind === 'tool-call') return <Card size="small" title={<Space><Tag color="blue">Tool call</Tag><Text strong>{part.name}</Text></Space>}><Descriptions size="small" column={1}><Descriptions.Item label="Call ID">{part.id ?? '—'}</Descriptions.Item></Descriptions><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{json(part.arguments)}</pre></Card>;
  if (part.kind === 'tool-result') return <Card size="small" title={<Space><Tag color={part.isError ? 'red' : 'green'}>Tool result</Tag><Text>{part.name ?? part.toolCallId ?? 'Tool output'}</Text></Space>}><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{json(part.content)}</pre></Card>;
  if (part.kind === 'refusal') return <Alert type="warning" showIcon message="Refusal" description={part.text} />;
  if (part.kind === 'json') return <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{json(part.value)}</pre>;
  return <Card size="small" title={<Tag>{part.kind === 'unknown' ? part.type : part.kind}</Tag>}><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{json(part.kind === 'unknown' ? part.value : part)}</pre></Card>;
}
function MessageView({ message }: { message: ContextMessage }) {
  const isUser = message.role === 'user';
  const label = [message.role, message.name, message.channel].filter(Boolean).join(' · ');
  const content = <Space direction="vertical" size="middle" style={{ width: '100%' }}>
    {message.parts.length ? message.parts.map((part, index) => <PartView key={index} part={part} />) : <Text type="secondary">Empty message</Text>}
    {message.recipient && <Text type="secondary">To: {message.recipient}</Text>}
    {message.tokenCount !== undefined && <Text type="secondary">{message.tokenCount.toLocaleString()} tokens</Text>}
  </Space>;
  return <Bubble placement={isUser ? 'end' : 'start'} variant="outlined" shape="round" header={<Space size={6}><Tag color={isUser ? 'blue' : message.role === 'assistant' ? 'purple' : 'default'}>{label}</Tag><Text type="secondary" style={{ fontSize: 11 }}>#{message.index + 1}</Text></Space>} content={content} />;
}
function JsonPanel({ value, title }: { value: unknown; title: string }) {
  return <Card size="small" title={title} extra={<Text type="secondary">{value == null ? 'not captured' : 'captured payload'}</Text>}>
    <Paragraph copyable={{ text: json(value) }} style={{ marginBottom: 8 }}><Text type="secondary">Copy JSON</Text></Paragraph>
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 560, overflow: 'auto', margin: 0 }}>{json(value)}</pre>
  </Card>;
}
export interface ContextExplorerProps { snapshot: ContextSnapshot; previous?: ContextSnapshot; className?: string }
/** Ant Design + Ant Design X inspector for captured provider exchanges. */
export function ContextExplorer({ snapshot, previous, className }: ContextExplorerProps) {
  const [activeKey, setActiveKey] = useState('messages');
  const diff = useMemo(() => previous ? diffContext(previous.messages, snapshot.messages) : undefined, [previous, snapshot]);
  const messages = [...snapshot.messages, ...snapshot.responseMessages];
  const tabs = [
    { key: 'messages', label: 'Messages', children: <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
      {snapshot.system && <Card size="small" title="System context"><Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{snapshot.system}</Paragraph></Card>}
      {messages.length ? messages.map((message) => <MessageView key={message.id} message={message} />) : <Empty description="No message payload captured" />}
    </Space> },
    { key: 'tools', label: <>Tools <Tag>{snapshot.tools.length}</Tag></>, children: snapshot.tools.length ? <Space direction="vertical" style={{ display: 'flex' }}>{snapshot.tools.map((tool, index) => <Card key={tool.name + index} size="small" title={tool.name}><Paragraph>{tool.description}</Paragraph><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{json(tool.inputSchema ?? tool.raw)}</pre></Card>)}</Space> : <Empty description="No tools declared" /> },
    { key: 'parameters', label: 'Parameters', children: <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }} items={Object.entries(snapshot.parameters).map(([key, value]) => ({ key, label: key, children: <Text code>{json(value)}</Text> }))} /> },
    { key: 'raw', label: 'Raw payload', children: <Space direction="vertical" style={{ display: 'flex' }}><JsonPanel title="Request" value={snapshot.rawRequest} />{snapshot.rawResponse !== undefined && <JsonPanel title="Response" value={snapshot.rawResponse} />}</Space> },
    ...(diff ? [{ key: 'diff', label: <>Context diff <Tag color={diff.changed || diff.added || diff.removed ? 'processing' : 'success'}>+{diff.added} / −{diff.removed} / ~{diff.changed}</Tag></>, children: diff.changes.length ? <Space direction="vertical" style={{ display: 'flex' }}>{diff.changes.map((change) => <Card key={change.index} size="small" title={<Space><Tag color={change.kind === 'added' ? 'green' : change.kind === 'removed' ? 'red' : change.kind === 'changed' ? 'orange' : 'default'}>{change.kind}</Tag>Message {change.index + 1}</Space>}><Text type="secondary">{change.changedFields?.join(', ')}</Text><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{json(change.after ?? change.before)}</pre></Card>)}</Space> : <Empty description="No message changes" /> }] : []),
  ];
  return <div className={className}>
    <Card size="small" styles={{ body: { padding: 16 } }}>
      <Space wrap size={[12, 8]} style={{ marginBottom: 12 }}>
        <Text strong>{snapshot.model ?? 'LLM request'}</Text><Tag color="blue">{snapshot.provider}</Tag><Tag>{snapshot.messages.length} request messages</Tag><Tag>{snapshot.tools.length} tools</Tag>
        {snapshot.usage && <Tag color="purple">{snapshot.usage.inputTokens ?? '—'} input / {snapshot.usage.outputTokens ?? '—'} output tokens</Tag>}
      </Space>
      {snapshot.usage && <Descriptions size="small" column={{ xs: 2, sm: 3, md: 5 }} items={[
        { key: 'in', label: 'Input', children: snapshot.usage.inputTokens?.toLocaleString() ?? '—' },
        { key: 'out', label: 'Output', children: snapshot.usage.outputTokens?.toLocaleString() ?? '—' },
        { key: 'total', label: 'Total', children: snapshot.usage.totalTokens?.toLocaleString() ?? '—' },
        { key: 'cached', label: 'Cached input', children: snapshot.usage.cachedInputTokens?.toLocaleString() ?? '—' },
        { key: 'reasoning', label: 'Reasoning', children: snapshot.usage.reasoningTokens?.toLocaleString() ?? '—' },
      ]} />}
    </Card>
    {snapshot.warnings.map((warning) => <Alert key={warning} style={{ marginTop: 8 }} type="warning" showIcon message={warning} />)}
    <Tabs activeKey={activeKey} onChange={setActiveKey} items={tabs} style={{ marginTop: 12 }} />
  </div>;
}
