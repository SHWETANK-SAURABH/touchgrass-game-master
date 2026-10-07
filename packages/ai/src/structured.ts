import { z } from 'zod';
import { err, ok, type Logger, type Result } from '@touchgrass/shared';
import { ModelProviderError } from './provider/errors';
import type {
  ChatMessage,
  GenerateJsonResult,
  GenerateOptions,
  ModelProvider,
} from './provider/types';

/**
 * Schema-constrained generation with a bounded repair loop.
 *
 * This is the mechanism that makes a 4B open-weight model trustworthy enough to
 * drive a game, and it works in three layers:
 *
 *  1. **Grammar.** The Zod schema is converted to JSON Schema and handed to the
 *     runtime, which constrains decoding. Most structural errors become
 *     impossible rather than merely unlikely.
 *  2. **Validation.** The result is parsed with the same Zod schema. The grammar
 *     guarantees shape, not meaning: a model can emit a perfectly well-formed
 *     `durationSeconds: 300` that still breaks a rule, and only Zod catches that.
 *  3. **Repair.** On a validation failure the model is told exactly which fields
 *     were wrong and asked once more, up to `maxRepairAttempts`. Smaller models
 *     repair well when the feedback names the field and the constraint, which is
 *     why the proposal schemas use a discriminated union — per-branch errors are
 *     actionable where "invalid union" is not.
 *
 * Nothing here decides whether output is *safe*. That is a separate, deterministic
 * pass over validated data; see packages/safety. Validation answers "is this the
 * right shape"; safety answers "should this reach a child in a field".
 */

export interface StructuredFailure {
  readonly code: 'OUTPUT_SCHEMA_INVALID' | 'OUTPUT_NOT_JSON';
  readonly message: string;
  /** What was wrong with the final attempt, one line per problem. */
  readonly issues: readonly string[];
  /** The raw completion that failed, truncated. Kept for prompt debugging. */
  readonly raw: string;
  readonly attempts: number;
}

export interface StructuredResult<T> {
  readonly data: T;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly model: string;
}

export interface GenerateStructuredRequest<T> extends GenerateOptions {
  readonly provider: ModelProvider;
  readonly schema: z.ZodType<T>;
  readonly schemaName?: string;
  readonly messages: readonly ChatMessage[];
  /** Extra tries after the first failure. 0 disables repair. Default 1. */
  readonly maxRepairAttempts?: number;
  readonly logger?: Logger;
}

/**
 * Converts a Zod schema into the JSON Schema dialect both runtimes accept.
 *
 * `io: 'input'` matters: it describes what the model must *produce*, so fields
 * with Zod defaults are optional rather than required. `unrepresentable: 'any'`
 * keeps a schema containing a refinement from throwing — the refinement still
 * runs during validation, it simply cannot be expressed as a grammar constraint.
 */
export function toJsonSchema(
  schema: z.ZodType,
  name = 'structured_output',
): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-7',
    unrepresentable: 'any',
    override: (context) => {
      // Name the root so the OpenAI-compatible adapter has a stable schema name.
      if (context.path.length === 0) context.jsonSchema.title ??= name;
    },
  });
}

/** Turns Zod issues into one line per problem, naming the field and the constraint. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

function repairPrompt(issues: readonly string[], raw: string): ChatMessage {
  return {
    role: 'user',
    content: [
      'Your previous reply did not satisfy the required schema.',
      '',
      'Problems:',
      ...issues.map((issue) => `- ${issue}`),
      '',
      'Your previous reply was:',
      raw.slice(0, 1_000),
      '',
      'Reply again with corrected JSON only. Do not explain. Do not add fields.',
    ].join('\n'),
  };
}

export async function generateStructured<T>(
  request: GenerateStructuredRequest<T>,
): Promise<Result<StructuredResult<T>, StructuredFailure>> {
  const {
    provider,
    schema,
    schemaName = 'structured_output',
    maxRepairAttempts = 1,
    logger,
  } = request;

  const jsonSchema = toJsonSchema(schema, schemaName);
  const messages: ChatMessage[] = [...request.messages];
  let totalLatencyMs = 0;
  let lastIssues: string[] = [];
  let lastRaw = '';
  let lastCode: StructuredFailure['code'] = 'OUTPUT_SCHEMA_INVALID';

  for (let attempt = 1; attempt <= maxRepairAttempts + 1; attempt += 1) {
    let generation: GenerateJsonResult;
    try {
      generation = await provider.generateJson({
        messages,
        jsonSchema,
        schemaName,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (cause) {
      // A completion that is not JSON is a model mistake, so it spends an attempt
      // and gets the same repair treatment as a schema violation. Anything else
      // (unreachable host, timeout, cancellation) is rethrown for the caller's
      // fallback strategy.
      if (!(cause instanceof ModelProviderError) || cause.code !== 'OUTPUT_NOT_JSON') throw cause;

      lastCode = 'OUTPUT_NOT_JSON';
      lastRaw = typeof cause.context.raw === 'string' ? cause.context.raw : '';
      lastIssues = ['(root): the reply was not valid JSON'];
      logger?.warn('structured generation returned non-JSON output', { attempt });

      if (attempt <= maxRepairAttempts) {
        messages.push({ role: 'assistant', content: lastRaw });
        messages.push(repairPrompt(lastIssues, lastRaw));
      }
      continue;
    }

    totalLatencyMs += generation.latencyMs;
    lastRaw = generation.raw;
    lastCode = 'OUTPUT_SCHEMA_INVALID';

    const parsed = schema.safeParse(generation.data);
    if (parsed.success) {
      logger?.debug('structured generation succeeded', {
        attempts: attempt,
        latencyMs: totalLatencyMs,
        model: generation.model,
      });
      return ok({
        data: parsed.data,
        attempts: attempt,
        latencyMs: totalLatencyMs,
        model: generation.model,
      });
    }

    lastIssues = describeIssues(parsed.error);
    logger?.warn('structured generation failed validation', {
      attempt,
      issues: lastIssues,
      model: generation.model,
    });

    if (attempt <= maxRepairAttempts) {
      messages.push({ role: 'assistant', content: generation.raw });
      messages.push(repairPrompt(lastIssues, generation.raw));
    }
  }

  return err({
    code: lastCode,
    message: `Model output was still invalid after ${String(maxRepairAttempts + 1)} attempt(s).`,
    issues: lastIssues,
    raw: lastRaw.slice(0, 1_000),
    attempts: maxRepairAttempts + 1,
  });
}
