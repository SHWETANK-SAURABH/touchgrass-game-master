import { Agent } from '@mastra/core/agent';
import { noopLogger } from '@mastra/core/logger';
import { err, ok, type Logger, type Result, type ServerEnv } from '@touchgrass/shared';
import { type ModelErrorCode, ModelProviderError } from '../provider/errors';
import { createModelProviderFromEnv } from '../provider/registry';
import type { ModelProvider } from '../provider/types';
import { type GameMasterContext, buildGameMasterView } from './context';
import { createProviderLanguageModel } from './model-adapter';
import {
  type GameMasterTool,
  type ToolCallRecord,
  createToolSet,
  runToolCall,
} from '../tools/tool';
import {
  GAME_MASTER_SYSTEM_PROMPT,
  buildGameMasterMessages,
  buildRepairMessages,
  buildToolInstructions,
  buildToolResultMessages,
} from './prompt';
import {
  type GameMasterProposal,
  parseGameMasterProposal,
  parseToolRequest,
  proposalOutputSchemaFor,
  stepOutputSchemaFor,
} from './proposal';

/**
 * The Game Master.
 *
 *   GameState + GameDefinition  →  Game Master  →  proposal  →  returned
 *
 * One Mastra agent, one capability: look at a game and propose at most one
 * external game event, with a reason. It has no memory and no access to the
 * engine's entry points. It reads the context it is given and returns a value.
 * Applying a proposal, and deciding whether it is safe or legal, are not done
 * here.
 *
 * The agent itself is built with no tools: the model is never given a native
 * way to call anything. If the application lists read-only tools, the model
 * may ask for one by replying with a tool request instead of a proposal. This
 * module then checks and runs it, gives the answer back, and asks again. That
 * loop belongs to this code: it runs at most `maxToolCalls` times, after which
 * only a proposal is accepted.
 *
 * The model is whatever `ModelProvider` it is constructed with — Gemma on a
 * local Ollama by default. If that runtime is unreachable or the model is not
 * there, `propose` returns a typed failure; it never substitutes another model.
 */

export const GAME_MASTER_ERROR_CODES = [
  /** The definition does not match the state's game. */
  'INVALID_CONTEXT',
  /** The game is not in a running round, so there is nothing to propose. */
  'GAME_NOT_ACTIVE',
  /** The model runtime could not produce a reply. See `modelErrorCode`. */
  'MODEL_UNAVAILABLE',
  /** The model replied, but not with a valid proposal, after every attempt. */
  'INVALID_PROPOSAL',
] as const;
export type GameMasterErrorCode = (typeof GAME_MASTER_ERROR_CODES)[number];

export interface GameMasterError {
  readonly code: GameMasterErrorCode;
  readonly message: string;
  /** Set for MODEL_UNAVAILABLE: why the runtime failed. */
  readonly modelErrorCode?: ModelErrorCode;
  /** Set for INVALID_PROPOSAL: what was wrong with the last reply. */
  readonly issues?: readonly string[];
  /** Set for INVALID_PROPOSAL: the last reply, truncated. */
  readonly raw?: string;
  readonly attempts?: number;
  /** The tool calls made before the failure. Present only when tools were listed. */
  readonly toolCalls?: readonly ToolCallRecord[];
}

export interface GameMasterResult {
  readonly proposal: GameMasterProposal;
  /** 1 if the first reply was valid; more if a repair was needed. */
  readonly attempts: number;
  readonly provider: string;
  readonly model: string;
  /** The tool calls made on the way, in order. Present only when tools were listed. */
  readonly toolCalls?: readonly ToolCallRecord[];
}

export interface GameMaster {
  /** The provider and model this Game Master was built with. */
  readonly provider: string;
  readonly model: string;
  /** The underlying Mastra agent. It has no tools. */
  readonly agent: Agent;
  propose(
    context: GameMasterContext,
    options?: {
      readonly signal?: AbortSignal;
      /** Whether the game is still wanted. Asked before each tool call. */
      readonly available?: () => boolean;
    },
  ): Promise<Result<GameMasterResult, GameMasterError>>;
}

/** At most this many tool calls in one turn, unless the application says fewer. */
export const DEFAULT_MAX_TOOL_CALLS = 2;
/** The most the application may allow. */
export const MAX_TOOL_CALLS_LIMIT = 4;
/** One tool call may take this long. */
export const DEFAULT_TOOL_TIMEOUT_MS = 2_000;
/** The largest tool answer handed back to the model, in bytes of JSON. */
export const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 4_096;

export interface GameMasterOptions {
  readonly provider: ModelProvider;
  /** Extra tries after an invalid reply. 0 disables repair. Default 1. */
  readonly maxRepairAttempts?: number;
  readonly logger?: Logger;
  /**
   * The read-only tools the model may ask for. Left out or empty, there are
   * none, and the model is asked exactly as it was before tools existed.
   */
  readonly tools?: readonly GameMasterTool[];
  /** How many tool calls one turn may make. Default 2, never more than 4. */
  readonly maxToolCalls?: number;
  /** How long one tool call may take. Default 2 seconds. */
  readonly toolTimeoutMs?: number;
  /** The largest tool answer handed back to the model. Default 4 KB. */
  readonly maxToolOutputBytes?: number;
  /** Told what a tool threw. Never shown to the model. */
  readonly onToolError?: (toolName: string, error: unknown) => void;
}

function tryParseJson(text: string): Result<unknown, string[]> {
  try {
    return ok(JSON.parse(text.trim()));
  } catch {
    return err(['(root): the reply was not valid JSON']);
  }
}

export function createGameMaster(options: GameMasterOptions): GameMaster {
  const { provider, maxRepairAttempts = 1, logger } = options;
  // The allowlist is fixed here, when the application builds the Game Master.
  const toolSet = createToolSet(options.tools ?? []);
  const maxToolCalls =
    toolSet.tools.length === 0
      ? 0
      : Math.max(0, Math.min(options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS, MAX_TOOL_CALLS_LIMIT));
  const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const maxToolOutputBytes = options.maxToolOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES;

  const agent = new Agent({
    id: 'game-master',
    name: 'TouchGrass Game Master',
    instructions: GAME_MASTER_SYSTEM_PROMPT,
    model: createProviderLanguageModel(provider),
    // No tools. In particular the game engine is not exposed to the model.
    tools: {},
    // Retries belong to the provider's transport, which already bounds them.
    maxRetries: 0,
  });
  // Mastra's default logger prints to the console; ours is injected instead.
  agent.__setLogger(noopLogger);

  return {
    provider: provider.id,
    model: provider.model,
    agent,

    async propose(context, callOptions = {}) {
      const { state, definition } = context;

      if (definition.id !== state.gameId) {
        return err({
          code: 'INVALID_CONTEXT',
          message: `The definition "${definition.id}" is not the game being played ("${state.gameId}").`,
        });
      }
      if (state.status !== 'active') {
        return err({
          code: 'GAME_NOT_ACTIVE',
          message: `The Game Master only proposes during a running round; the game is "${state.status}".`,
        });
      }

      const proposalSchema = proposalOutputSchemaFor(definition);
      const stepSchema = stepOutputSchemaFor(definition, toolSet.names);
      const messages = buildGameMasterMessages(buildGameMasterView(context));
      if (maxToolCalls > 0) messages.push(buildToolInstructions(toolSet.tools, maxToolCalls));
      const toolCalls: ToolCallRecord[] = [];
      const withTools = maxToolCalls > 0 ? { toolCalls } : {};
      let issues: string[] = [];
      let raw = '';

      // The loop is bounded twice over: an invalid reply spends an attempt, and
      // a tool call spends one of a fixed number of tool calls. Nothing the
      // model replies can add to either.
      for (let attempt = 1; attempt <= maxRepairAttempts + 1;) {
        const toolsOpen = toolCalls.length < maxToolCalls;
        const schema = toolsOpen ? stepSchema : proposalSchema;
        try {
          const output = await agent.generate(messages, {
            // The schema reaches the runtime as a decoding constraint. 'warn'
            // stops Mastra throwing on a mismatch, so that validation and the
            // error messages are ours, below.
            structuredOutput: { schema, errorStrategy: 'warn' },
            maxSteps: 1,
            ...(callOptions.signal ? { abortSignal: callOptions.signal } : {}),
          });
          raw = output.text;
        } catch (cause) {
          if (!(cause instanceof ModelProviderError)) throw cause;
          if (cause.code !== 'OUTPUT_NOT_JSON') {
            logger?.warn('game master: model unavailable', { code: cause.code });
            return err({
              code: 'MODEL_UNAVAILABLE',
              message: cause.message,
              modelErrorCode: cause.code,
              attempts: attempt,
              ...withTools,
            });
          }
          // The runtime answered with something that is not JSON: a bad reply,
          // not a dead model. It spends an attempt like any other invalid reply.
          raw = typeof cause.context.raw === 'string' ? cause.context.raw : '';
        }

        const json = tryParseJson(raw);

        // A tool request, while tool calls remain: check it, run it, hand the
        // answer back, and ask again. It is not an attempt at a proposal.
        const request = json.ok && toolsOpen ? parseToolRequest(json.value) : null;
        if (request) {
          const { record, result } = await runToolCall(
            toolSet,
            { name: request.tool.name, input: request.tool.input ?? {} },
            { state, definition, now: context.now },
            {
              timeoutMs: toolTimeoutMs,
              maxOutputBytes: maxToolOutputBytes,
              ...(callOptions.available ? { available: callOptions.available } : {}),
              ...(options.onToolError ? { onError: options.onToolError } : {}),
            },
          );
          toolCalls.push(record);
          logger?.debug('game master: tool call', { tool: record.name, ok: record.ok });
          messages.push(
            ...buildToolResultMessages(raw, record.name, result, maxToolCalls - toolCalls.length),
          );
          continue;
        }

        const parsed = json.ok ? parseGameMasterProposal(json.value, definition) : json;
        if (parsed.ok) {
          logger?.debug('game master: proposal', {
            attempts: attempt,
            event: parsed.value.event?.type ?? null,
          });
          return ok({
            proposal: parsed.value,
            attempts: attempt,
            provider: provider.id,
            model: provider.model,
            ...withTools,
          });
        }

        issues = parsed.error;
        logger?.warn('game master: invalid proposal', { attempt, issues });
        if (attempt <= maxRepairAttempts) messages.push(...buildRepairMessages(issues, raw));
        attempt += 1;
      }

      return err({
        code: 'INVALID_PROPOSAL',
        message: `The model did not return a valid proposal after ${String(maxRepairAttempts + 1)} attempt(s).`,
        issues,
        raw: raw.slice(0, 1_000),
        attempts: maxRepairAttempts + 1,
        ...withTools,
      });
    },
  };
}

/** Builds the Game Master from validated environment: MODEL_PROVIDER, MODEL_NAME, MODEL_BASE_URL. */
export function createGameMasterFromEnv(
  env: ServerEnv,
  options: Omit<GameMasterOptions, 'provider'> = {},
): GameMaster {
  return createGameMaster({ ...options, provider: createModelProviderFromEnv(env) });
}
