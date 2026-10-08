import type { z } from 'zod';
import type { GameDefinition } from '@touchgrass/game-definitions';
import type { GameState } from '@touchgrass/game-engine';

/**
 * Tools the Game Master may be given.
 *
 * A tool is a narrow, read-only question the model may ask about the one game
 * it is looking at. It is not a way to act. A tool has a name, a description,
 * a schema for what it is asked and a schema for what it answers, and one
 * function. That function is handed its input and a scope, and nothing else:
 *
 *   the scope   the frozen state of this one game, its definition, and the time
 *
 * There is no session id in a tool's input and no lookup behind it, so a tool
 * call cannot name another game. A tool is never handed a session, a room, a
 * store, a socket, a file handle or the network.
 *
 * The application decides which tools exist, by passing a list when it builds
 * the Game Master. The model cannot add one, and asking for one that is not on
 * the list is a refusal like any other.
 *
 * Every call is checked here, in order, and each check that fails is a
 * controlled answer to the model, never an exception:
 *
 *   the game is still wanted     else SESSION_UNAVAILABLE
 *   the tool is on the list      else UNKNOWN_TOOL
 *   the input fits its schema    else INVALID_ARGUMENTS
 *   it answers in time           else TOOL_TIMEOUT
 *   it does not throw            else TOOL_FAILED
 *   the output fits its schema   else INVALID_OUTPUT
 *   the output is small enough   else OUTPUT_TOO_LARGE
 *
 * What the model is told about a failure is its code. Never a message, a stack
 * or anything the tool threw.
 */

/** What a tool may look at: one game, and the time. */
export interface ToolScope {
  /** The game as the engine holds it. Frozen: a tool reads it and cannot change it. */
  readonly state: GameState;
  /** The definition of that game. */
  readonly definition: GameDefinition;
  /** The engine's clock value, epoch ms. */
  readonly now: number;
}

export interface GameMasterTool<Input = unknown, Output = unknown> {
  /** Lower-case letters, digits and underscores. How the model names the tool. */
  readonly name: string;
  /** One or two sentences, shown to the model. */
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;
  /** Answers the question. It must only read the scope. */
  readonly execute: (input: Input, scope: ToolScope) => Output | Promise<Output>;
}

/**
 * Declares a tool with its own input and output types, and hands it back in the
 * form a list of tools holds. Its schemas are what check the types at run time.
 */
export function defineTool<Input, Output>(tool: GameMasterTool<Input, Output>): GameMasterTool {
  return tool as unknown as GameMasterTool;
}

export const TOOL_FAILURE_CODES = [
  'SESSION_UNAVAILABLE',
  'UNKNOWN_TOOL',
  'INVALID_ARGUMENTS',
  'TOOL_TIMEOUT',
  'TOOL_FAILED',
  'INVALID_OUTPUT',
  'OUTPUT_TOO_LARGE',
] as const;
export type ToolFailureCode = (typeof TOOL_FAILURE_CODES)[number];

/** What is kept of one tool call: which tool, how it ended, how long it took. Never its input or output. */
export interface ToolCallRecord {
  /** The tool's name, or "(unknown)" when the model asked for one that does not exist. */
  readonly name: string;
  readonly ok: boolean;
  readonly code?: ToolFailureCode;
  readonly durationMs: number;
}

export type ToolResult =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly code: ToolFailureCode };

export interface ToolRunOptions {
  /** How long one call may take. */
  readonly timeoutMs: number;
  /** The largest output handed back to the model, in bytes of JSON. */
  readonly maxOutputBytes: number;
  /** Whether the game is still wanted. Asked before the tool runs. */
  readonly available?: () => boolean;
  /** Told what a tool threw, for whoever monitors errors. Never shown to the model. */
  readonly onError?: (toolName: string, error: unknown) => void;
  /** A monotonic clock in milliseconds, for durations. */
  readonly elapsed?: () => number;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{1,39}$/;

/** A fixed set of tools, by name. */
export interface ToolSet {
  readonly names: readonly string[];
  readonly tools: readonly GameMasterTool[];
  readonly get: (name: unknown) => GameMasterTool | undefined;
}

/**
 * Makes the allowlist. A tool with a badly formed name, or two tools with the
 * same name, is a mistake in the application and is refused here, at start-up.
 */
export function createToolSet(tools: readonly GameMasterTool[]): ToolSet {
  const byName = new Map<string, GameMasterTool>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) {
      throw new Error(`"${tool.name}" is not a valid tool name.`);
    }
    if (byName.has(tool.name)) throw new Error(`The tool "${tool.name}" is listed twice.`);
    byName.set(tool.name, tool);
  }
  return {
    names: [...byName.keys()],
    tools: [...byName.values()],
    get: (name) => (typeof name === 'string' ? byName.get(name) : undefined),
  };
}

/**
 * Runs one tool call the model asked for. It never throws and never rejects:
 * every way a call can go wrong is a `ToolResult` with a code.
 */
export async function runToolCall(
  toolSet: ToolSet,
  call: { readonly name: unknown; readonly input: unknown },
  scope: ToolScope,
  options: ToolRunOptions,
): Promise<{ readonly record: ToolCallRecord; readonly result: ToolResult }> {
  const elapsed = options.elapsed ?? (() => performance.now());
  const startedAt = elapsed();
  const tool = toolSet.get(call.name);
  const name = tool?.name ?? '(unknown)';
  const finish = (result: ToolResult) => ({
    record: {
      name,
      ok: result.ok,
      ...(result.ok ? {} : { code: result.code }),
      durationMs: Math.max(0, Math.round(elapsed() - startedAt)),
    },
    result,
  });
  const failed = (code: ToolFailureCode) => finish({ ok: false, code });

  if (options.available && !options.available()) return failed('SESSION_UNAVAILABLE');
  if (!tool) return failed('UNKNOWN_TOOL');

  const input = tool.inputSchema.safeParse(call.input);
  if (!input.success) return failed('INVALID_ARGUMENTS');

  let output: unknown;
  try {
    const limit = AbortSignal.timeout(options.timeoutMs);
    const timedOut = new Promise<'TIMED_OUT'>((resolve) => {
      limit.addEventListener(
        'abort',
        () => {
          resolve('TIMED_OUT');
        },
        { once: true },
      );
    });
    const running = Promise.resolve().then(() => tool.execute(input.data, scope));
    // If the limit wins, whatever the tool does later is dropped.
    running.catch(() => undefined);
    const first = await Promise.race([running, timedOut]);
    if (first === 'TIMED_OUT') return failed('TOOL_TIMEOUT');
    output = first;
  } catch (error) {
    try {
      options.onError?.(tool.name, error);
    } catch {
      // Being told is a courtesy.
    }
    return failed('TOOL_FAILED');
  }

  const checked = tool.outputSchema.safeParse(output);
  if (!checked.success) return failed('INVALID_OUTPUT');

  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(checked.data) ?? '', 'utf8');
  } catch {
    return failed('INVALID_OUTPUT');
  }
  if (size > options.maxOutputBytes) return failed('OUTPUT_TOO_LARGE');
  return finish({ ok: true, output: checked.data });
}
