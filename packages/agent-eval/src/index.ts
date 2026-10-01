export interface EvalCase<TInput = unknown, TExpected = unknown, TContext = unknown> {
  id: string;
  input: TInput;
  expected?: TExpected;
  context?: TContext;
  metadata?: Record<string, unknown>;
}

export interface EvalObservation<TOutput = unknown> {
  output?: TOutput;
  error?: string;
  durationMs?: number;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface EvalGraderInput<TInput = unknown, TExpected = unknown, TOutput = unknown, TContext = unknown> {
  testCase: EvalCase<TInput, TExpected, TContext>;
  observation: EvalObservation<TOutput>;
}

export interface EvalGrade {
  grader: string;
  pass: boolean;
  score?: number;
  explanation?: string;
  metadata?: Record<string, unknown>;
}

export type EvalGrader<TInput = unknown, TExpected = unknown, TOutput = unknown, TContext = unknown> =
  (input: EvalGraderInput<TInput, TExpected, TOutput, TContext>) => EvalGrade | Promise<EvalGrade>;

export interface EvalCaseResult<TInput = unknown, TExpected = unknown, TOutput = unknown, TContext = unknown> {
  testCase: EvalCase<TInput, TExpected, TContext>;
  observation: EvalObservation<TOutput>;
  grades: EvalGrade[];
}

/** 对一个真实 agent observation 运行多个独立 grader；不定义 agent 如何执行。 */
export async function gradeCase<TInput, TExpected, TOutput, TContext>(
  testCase: EvalCase<TInput, TExpected, TContext>,
  observation: EvalObservation<TOutput>,
  graders: Array<EvalGrader<TInput, TExpected, TOutput, TContext>>,
): Promise<EvalCaseResult<TInput, TExpected, TOutput, TContext>> {
  const grades = await Promise.all(graders.map((grader) => grader({ testCase, observation })));
  return { testCase, observation, grades };
}

export interface EvalSummary {
  caseCount: number;
  passedCases: number;
  failedCases: number;
  graderResults: number;
  failures: Array<{ caseId: string; grader: string; explanation?: string }>;
}

/** 只做聚合，不把不同业务的分数硬合成一个“总分”。 */
export function summarizeEval(results: EvalCaseResult[]): EvalSummary {
  const failures: EvalSummary['failures'] = [];
  let passedCases = 0;

  for (const result of results) {
    const failed = result.grades.filter((grade) => !grade.pass);
    if (failed.length === 0) {
      passedCases += 1;
    } else {
      for (const grade of failed) {
        failures.push({ caseId: result.testCase.id, grader: grade.grader, ...(grade.explanation ? { explanation: grade.explanation } : {}) });
      }
    }
  }

  return {
    caseCount: results.length,
    passedCases,
    failedCases: results.length - passedCases,
    graderResults: results.reduce((count, result) => count + result.grades.length, 0),
    failures,
  };
}