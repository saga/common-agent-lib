import * as z from 'zod';

/** 从模型回复里提取最外层 JSON 对象；优先 fenced JSON，再退回首尾大括号。 */
export function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\\s*([\\s\\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw.trim();
}

export interface ParsedStructuredOutput<T> {
  value: T;
  json: string;
}

/**
 * Provider-neutral 的最终 Schema 门。
 * OpenAI / LangChain 等能直接给你 parsed object 时，调用方也可以跳过字符串解析，
 * 直接调用 validateStructuredOutput。
 */
export function validateStructuredOutput<T>(value: unknown, schema: z.ZodType<T>): T {
  return schema.parse(value);
}

/** 兼容旧式「模型直接吐 JSON 文本」的执行器。 */
export function parseStructuredOutput<T>(raw: string, schema: z.ZodType<T>): ParsedStructuredOutput<T> {
  const json = extractJsonObject(raw);
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error('模型没有返回合法 JSON：' + (error instanceof Error ? error.message : String(error)));
  }
  return { value: validateStructuredOutput(value, schema), json };
}