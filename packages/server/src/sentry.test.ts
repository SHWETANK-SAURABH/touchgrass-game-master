import { describe, expect, it } from 'vitest';
import { createSentryReporter } from './sentry';

/**
 * The real Sentry SDK, with the network replaced: what would be sent is kept
 * here instead. No Sentry account or DSN is needed, and nothing leaves the
 * machine. The DSN below names a host that cannot exist.
 */

const DSN = 'https://publickey@o0.ingest.example.invalid/1';
const TOKEN = 'kJ8sP2mQ9xR4tV7wY1zA3bC5dE6fG8hJ0kL2mN4pQ6r';
const URI = 'mongodb://admin:hunter-two@db.example.invalid:27017/touchgrass';
const SESSION = 'ses_0b1e4c88-1111-2222-3333-444455556666';

function reporterWithFakeTransport() {
  const sent: unknown[] = [];
  const reporter = createSentryReporter({
    dsn: DSN,
    environment: 'test',
    transport: () => ({
      send: (envelope) => {
        sent.push(envelope);
        return Promise.resolve({ statusCode: 200 });
      },
      flush: () => Promise.resolve(true),
    }),
  });
  /** The events sent so far: the payload of each envelope item that is an event. */
  const events = (): Record<string, unknown>[] =>
    sent.flatMap((envelope) =>
      ((envelope as [unknown, [{ type?: string }, Record<string, unknown>][]])[1] ?? [])
        .filter(([header]) => header.type === 'event')
        .map(([, payload]) => payload),
    );
  return { reporter, sent, events };
}

describe('the Sentry reporter', () => {
  it('sends an unexpected error with its tags', async () => {
    const { reporter, events } = reporterWithFakeTransport();
    reporter.captureError(new RangeError('the turn broke'), {
      area: 'game_master',
      stage: 'turn',
      code: 'UNEXPECTED',
      provider: 'ollama',
      model: 'gemma3:4b',
    });
    await reporter.flush();

    const [event] = events();
    expect(events()).toHaveLength(1);
    expect(event?.environment).toBe('test');
    expect(event?.tags).toEqual({
      area: 'game_master',
      stage: 'turn',
      code: 'UNEXPECTED',
      provider: 'ollama',
      model: 'gemma3:4b',
    });
    const exception = (event?.exception as { values: { type: string; value: string }[] }).values[0];
    expect(exception).toMatchObject({ type: 'RangeError', value: 'the turn broke' });
  });

  it('sends a failure as a warning with a fixed name and its code', async () => {
    const { reporter, events } = reporterWithFakeTransport();
    reporter.captureFailure('session eviction failed', {
      area: 'persistence',
      stage: 'eviction',
      code: 'STORAGE_ERROR',
    });
    await reporter.flush();
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      message: 'session eviction failed',
      level: 'warning',
      tags: { area: 'persistence', stage: 'eviction', code: 'STORAGE_ERROR' },
    });
  });

  it('sends no token, connection string, session id or attached data, wherever it was put', async () => {
    const { reporter, sent, events } = reporterWithFakeTransport();
    const error = Object.assign(
      new Error(`resume token ${TOKEN} refused for ${SESSION} at ${URI}`),
      {
        hostToken: TOKEN,
        sessionId: SESSION,
        state: { players: [{ displayName: 'Ada Secretname' }] },
      },
    );
    reporter.captureError(error, {
      area: 'tool',
      tool: 'game_history',
      code: TOKEN,
      sessionId: SESSION,
      playerName: 'Ada Secretname',
      token: TOKEN,
    } as never);
    reporter.captureFailure(`could not save ${SESSION} to ${URI} with ${TOKEN}`, {
      area: 'persistence',
    });
    await reporter.flush();

    expect(events()).toHaveLength(2);
    const everything = JSON.stringify(sent);
    for (const hidden of [
      TOKEN,
      'hunter-two',
      'db.example.invalid',
      SESSION,
      'Secretname',
      'hostToken',
    ]) {
      expect(everything.includes(hidden), hidden).toBe(false);
    }
    // Only tags from the fixed list survive, and their values are scrubbed too.
    expect(events()[0]?.tags).toEqual({ area: 'tool', tool: 'game_history', code: '[redacted]' });
    expect(events()[1]?.message).toBe('could not save [redacted] to [address] with [redacted]');
  });

  it('adds nothing about the machine, the user or what came before', async () => {
    const { reporter, events } = reporterWithFakeTransport();
    console.log('a line that must not become a breadcrumb');
    reporter.captureError(new Error('x'), { area: 'server' });
    await reporter.flush();
    const [event] = events();
    for (const field of ['user', 'request', 'breadcrumbs', 'extra', 'server_name', 'modules']) {
      expect(event?.[field], field).toBeUndefined();
    }
    expect(event?.contexts).toEqual({});
    const frames = (event?.exception as { values: { stacktrace?: { frames?: object[] } }[] })
      .values[0]?.stacktrace?.frames;
    for (const frame of frames ?? []) {
      expect(Object.keys(frame)).not.toContain('vars');
      expect(Object.keys(frame)).not.toContain('context_line');
    }
  });

  it('copes with a thrown value that is not an error', async () => {
    const { reporter, events } = reporterWithFakeTransport();
    reporter.captureError({ token: TOKEN }, { area: 'server' });
    reporter.captureError(undefined);
    await reporter.flush();
    expect(events()).toHaveLength(2);
    expect(JSON.stringify(events())).not.toContain(TOKEN);
  });
});
