import { Agent } from '@mastra/core/agent';
import { noopLogger } from '@mastra/core/logger';
import { err, ok, type Logger, type Result, type ServerEnv } from '@touchgrass/shared';
import { type ModelErrorCode, ModelProviderError } from '../provider/errors';
import { createModelProviderFromEnv } from '../provider/registry';
import type { ModelProvider } from '../provider/types';
import { type GameMasterContext, buildGameMasterView } from './context';
import { createProviderLanguageModel } from './model-adapter';
import { GAME_MASTER_SYSTEM_PROMPT, buildGameMasterMessages, buildRepairMessages } from './prompt';
import {
  type GameMasterProposal,
  parseGameMasterProposal,
  proposalOutputSchemaFor,
} from './proposal';

/**
 * The Game Master.
 *
 *   GameState + GameDefinition  →  Game Master  →  proposal  →  returned
 *
 * One Mastra agent, one capability: look at a game and propose at most one
 * external game event, with a reason. It has no tools, no memory, and no access
 * to the engine's entry points. It reads the context it is given and returns a
 * value. Applying a proposal, and deciding whether it is safe or legal, are not
 * done here.
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
}

export interface GameMasterResult {
  readonly proposal: GameMasterProposal;
  /** 1 if the first reply was valid; more if a repair was needed. */
  readonly attempts: number;
  readonly provider: string;
  readonly model: string;
}

export interface GameMaster {
  /** The provider and model this Game Master was built with. */
  readonly provider: string;
  readonly model: string;
  /** The underlying Mastra agent. It has no tools. */
  readonly agent: Agent;
  propose(
    context: GameMasterContext,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<GameMasterResult, GameMasterError>>;
}

export interface GameMasterOptions {
  readonly provider: ModelProvider;
  /** Extra tries after an invalid reply. 0 disables repair. Default 1. */
  readonly maxRepairAttempts?: number;
  readonly logger?: Logger;
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

      const schema = proposalOutputSchemaFor(definition);
      const messages = buildGameMasterMessages(buildGameMasterView(context));
      let issues: string[] = [];
      let raw = '';

      for (let attempt = 1; attempt <= maxRepairAttempts + 1; attempt += 1) {
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
            });
          }
          // The runtime answered with something that is not JSON: a bad reply,
          // not a dead model. It spends an attempt like any other invalid reply.
          raw = typeof cause.context.raw === 'string' ? cause.context.raw : '';
        }

        const json = tryParseJson(raw);
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
          });
        }

        issues = parsed.error;
        logger?.warn('game master: invalid proposal', { attempt, issues });
        if (attempt <= maxRepairAttempts) messages.push(...buildRepairMessages(issues, raw));
      }

      return err({
        code: 'INVALID_PROPOSAL',
        message: `The model did not return a valid proposal after ${String(maxRepairAttempts + 1)} attempt(s).`,
        issues,
        raw: raw.slice(0, 1_000),
        attempts: maxRepairAttempts + 1,
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
