import type {
  DreamingMemoryType,
  DreamingUserDirectiveKind,
  ParsedDreamingUserDirective,
} from './types.js';

const directivePatterns: ReadonlyArray<{
  kind: DreamingUserDirectiveKind;
  memoryType: DreamingMemoryType;
  pattern: RegExp;
}> = [
  {
    kind: 'remember',
    memoryType: 'fact',
    pattern: /^(?:(?:请|麻烦)(?:你)?(?:帮我)?|你)?记住(?:一下)?(?:这件事)?[：:,，、\s]*(.+)$/u,
  },
  {
    kind: 'avoid',
    memoryType: 'constraint',
    pattern: /^(?:(?:以后|今后|下次|之后)[，,、\s]*)?(?:请)?(?:你)?不要再(?:犯|做|说|写|用|使用|提及|忽略)?[：:,，、\s]*(.+)$/u,
  },
  {
    kind: 'avoid',
    memoryType: 'constraint',
    pattern: /^(?:(?:以后|今后|下次|之后)[，,、\s]*)?(?:请)?(?:你)?(?:绝对)?(?:不能|不要|别)(?:再)?[：:,，、\s]*(.+)$/u,
  },
  {
    kind: 'remember',
    memoryType: 'fact',
    pattern: /^(?:please\s+)?remember(?:\s+that)?[：:,\s]+(.+)$/iu,
  },
  {
    kind: 'avoid',
    memoryType: 'constraint',
    pattern: /^(?:(?:next time|from now on|in future)[,\s]*)?(?:please\s+)?(?:do not|don't|never)\s+(.+?)(?:\s+again)?[.!。！]?$/iu,
  },
];

/**
 * Recognize unambiguous, direct user requests to remember something or avoid
 * repeating a behavior. Call only with a message whose author is authenticated
 * as the memory owner; never run this against imported documents or model output.
 */
export function detectUserMemoryDirective(text: string): ParsedDreamingUserDirective | undefined {
  if (typeof text !== 'string') return undefined;
  const value = text.trim();
  if (!value || value.length > 4_000) return undefined;

  // Credentials and authentication secrets are never persisted as personal memory.
  if (/(?:password|passphrase|api[\s_-]?key|access[\s_-]?token|secret|验证码|密码|口令|私钥|助记词|cvv|信用卡号)/iu.test(value)) {
    return undefined;
  }

  for (const item of directivePatterns) {
    const match = value.match(item.pattern);
    const instruction = match?.[1]?.trim().replace(/[。.!！?？]+$/u, '').trim();
    if (!instruction) continue;
    if (instruction.length > 2_000) return undefined;
    return {
      kind: item.kind,
      instruction,
      memoryType: inferMemoryType(item.kind, instruction, item.memoryType),
    };
  }
  return undefined;
}

function inferMemoryType(
  kind: DreamingUserDirectiveKind,
  instruction: string,
  fallback: DreamingMemoryType,
): DreamingMemoryType {
  if (kind === 'avoid') return 'constraint';
  if (/(?:喜欢|偏好|倾向|更愿意|不喜欢|讨厌|prefer|preference|like|dislike|favor)/iu.test(instruction)) {
    return 'preference';
  }
  if (/(?:目标|计划|打算|希望实现|想要达成|goal|plan to|aim to|want to achieve)/iu.test(instruction)) {
    return 'goal';
  }
  if (/(?:必须|务必|只能|需要遵守|不可|must|only|requirement|constraint)/iu.test(instruction)) {
    return 'constraint';
  }
  if (/(?:目前|当前|正在|现阶段|暂时|currently|at the moment|in progress)/iu.test(instruction)) {
    return 'ongoing-context';
  }
  if (/(?:熟悉|了解|掌握|擅长|经验|know|knowledge|experienced|proficient)/iu.test(instruction)) {
    return 'knowledge';
  }
  return fallback;
}
