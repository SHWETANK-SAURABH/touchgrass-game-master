import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@touchgrass/shared';
import { parseErrorReportingConfig, parseGameMasterConfig } from './config';
import type { GameMasterAudit } from './game-master-turns';
import { COUNTER_NAMES, TIMER_NAMES, createMetrics } from './metrics';
import { createObserver } from './observability';
import {
  type ErrorReporter,
  REPORT_TAG_NAMES,
  type ReportTags,
  cleanTags,
  noopReporter,
  scrubText,
  toReportableError,
} from './reporting';

const TOKEN = 'kJ8sP2mQ9xR4tV7wY1zA3bC5dE6fG8hJ0kL2mN4pQ6r';
const URI = 'mongodb://admin:hunter-two@db.example.invalid:27017/touchgrass';

/** A reporter that keeps what it was given. */
function recordingReporter() {
  const errors: { error: unknown; tags: ReportTags | undefined }[] = [];
  const failures: { name: string; tags: ReportTags | undefined }[] = [];
  const reporter: ErrorReporter = {
    captureError: (error, tags) => errors.push({ error, tags }),
    captureFailure: (name, tags) => failures.push({ name, tags }),
    flush: () => Promise.resolve(),
  };
  return { reporter, errors, failures };
}

function observed() {
  const metrics = createMetrics();
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const recording = recordingReporter();
  const observer = createObserver({
    metrics,
    logger,
    reporter: recording.reporter,
    recentAudits: 3,
  });
  return { metrics, lines, observer, ...recording };
}

const audit = (more: Partial<GameMasterAudit>): GameMasterAudit => ({
  invocationId: 'gm-1',
  sessionId: 'session-one',
  trigger: 'round_start',
  at: 1_700_000_000_000,
  provider: 'ollama',
  model: 'gemma3:4b',
  outcome: 'NO_EVENT',
  durationMs: 120,
  ...more,
});

describe('metrics', () => {
  it('start at zero, with a fixed set of names and no labels', () => {
    const snapshot = createMetrics().read();
    expect(Object.keys(snapshot.counters).sort()).toEqual([...COUNTER_NAMES].sort());
    expect(Object.keys(snapshot.timers).sort()).toEqual([...TIMER_NAMES].sort());
    expect(Object.values(snapshot.counters).every((value) => value === 0)).toBe(true);
    for (const name of [
      'game_master_invocations',
      'game_master_successes',
      'game_master_failures',
      'game_master_timeouts',
      'game_master_safety_rejections',
      'game_master_engine_rejections',
      'tool_invocations',
      'tool_failures',
      'session_loads',
      'session_evictions',
    ]) {
      expect(COUNTER_NAMES, name).toContain(name);
    }
  });

  it('count and time, and hand out copies', () => {
    const metrics = createMetrics();
    metrics.increment('session_loads');
    metrics.increment('session_loads', 2);
    metrics.observe('game_master_turn_ms', 100);
    metrics.observe('game_master_turn_ms', 300);
    metrics.observe('game_master_turn_ms', -5);
    const snapshot = metrics.read();
    expect(snapshot.counters.session_loads).toBe(3);
    expect(snapshot.timers.game_master_turn_ms).toEqual({ count: 3, totalMs: 400, maxMs: 300 });
    (snapshot.counters as { session_loads: number }).session_loads = 99;
    expect(metrics.read().counters.session_loads).toBe(3);
  });

  it('cannot be given a new name, so a session id or a model reply cannot become one', () => {
    const metrics = createMetrics();
    for (const name of ['session-one', TOKEN, 'constructor', '__proto__', 'toString']) {
      metrics.increment(name as never);
      metrics.observe(name as never, 5);
    }
    metrics.increment('session_loads', Number.NaN);
    metrics.observe('tool_call_ms', Number.POSITIVE_INFINITY);
    const snapshot = metrics.read();
    expect(Object.keys(snapshot.counters)).toHaveLength(COUNTER_NAMES.length);
    expect(Object.keys(snapshot.timers)).toHaveLength(TIMER_NAMES.length);
    expect(JSON.stringify(snapshot)).not.toMatch(/session-one|null/);
    expect(snapshot.counters.session_loads).toBe(0);
  });
});

describe('what leaves the process in a report', () => {
  it('has addresses and long runs of token characters removed', () => {
    expect(scrubText(`could not reach ${URI}`)).toBe('could not reach [address]');
    expect(scrubText(`token ${TOKEN} was refused`)).toBe('token [redacted] was refused');
    expect(scrubText('ws://localhost:3001/sessions/ses_0b1e4c88 closed')).toBe('[address] closed');
    expect(scrubText('ses_0b1e4c88-1111-2222-3333-444455556666')).toBe('[redacted]');
    expect(scrubText('x'.repeat(5_000))).toHaveLength(10);
    expect(scrubText('the save failed: STORAGE_ERROR')).toBe('the save failed: STORAGE_ERROR');
    expect(scrubText(`${'word '.repeat(200)}`).length).toBeLessThanOrEqual(300);
  });

  it('keeps only tags from the fixed list, with plain short values', () => {
    expect(REPORT_TAG_NAMES).toEqual(['area', 'stage', 'code', 'provider', 'model', 'tool']);
    expect(
      cleanTags({
        area: 'game_master',
        stage: 'turn',
        code: 'UNEXPECTED',
        provider: 'ollama',
        model: 'gemma3:4b',
        tool: 'game_rules',
        sessionId: 'session-one',
        playerId: 'plr_1',
        token: TOKEN,
      } as ReportTags),
    ).toEqual({
      area: 'game_master',
      stage: 'turn',
      code: 'UNEXPECTED',
      provider: 'ollama',
      model: 'gemma3:4b',
      tool: 'game_rules',
    });
    expect(cleanTags({ code: TOKEN, tool: `x\n<script>${URI}` })).toEqual({
      code: '[redacted]',
      tool: 'x__script_[address]',
    });
    expect(cleanTags({ area: '', code: 5 as never })).toEqual({});
    expect(cleanTags(undefined)).toEqual({});
    expect(cleanTags({ model: 'm'.repeat(500) }).model?.length).toBeLessThanOrEqual(64);
  });

  it('is an error of the same kind with its text and trace scrubbed, and nothing else attached', () => {
    const original = Object.assign(new TypeError(`bad token ${TOKEN} for ${URI}`), {
      sessionId: 'session-one',
      hostToken: TOKEN,
      cause: new Error(URI),
    });
    const safe = toReportableError(original);
    expect(safe).not.toBe(original);
    expect(safe.name).toBe('TypeError');
    expect(safe.message).toBe('bad token [redacted] for [address]');
    const everything = JSON.stringify({ ...safe, message: safe.message, stack: safe.stack });
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('hunter-two');
    // Nothing that was attached to the original came across.
    expect(Object.keys(safe).filter((key) => key !== 'name')).toEqual([]);
    expect(safe.cause).toBeUndefined();

    expect(toReportableError('a string was thrown').message).toBe(
      'A value that is not an error was thrown.',
    );
    expect(toReportableError({ name: TOKEN }).name).toBe('Error');
  });

  it('goes nowhere by default', async () => {
    expect(() => {
      noopReporter.captureError(new Error('x'), { area: 'server' });
      noopReporter.captureFailure('x');
    }).not.toThrow();
    await expect(noopReporter.flush()).resolves.toBeUndefined();
  });
});

describe('the observer', () => {
  it('counts and logs what happens to sessions, and reports only a save that failed', () => {
    const { observer, metrics, lines, failures } = observed();
    for (const type of [
      'created',
      'loaded',
      'idle',
      'eviction_started',
      'unloaded',
      'evicted',
    ] as const) {
      observer.onSessionEvent({ type, sessionId: 'session-one', at: 1 });
    }
    observer.onSessionEvent({
      type: 'eviction_failed',
      sessionId: 'session-one',
      at: 2,
      code: 'SESSION_IN_USE',
    });
    expect(failures).toEqual([]);
    observer.onSessionEvent({
      type: 'eviction_failed',
      sessionId: 'session-one',
      at: 3,
      code: 'STORAGE_ERROR',
    });

    expect(metrics.read().counters).toMatchObject({
      session_creates: 1,
      session_loads: 1,
      session_evictions: 1,
      session_unloads: 1,
      session_eviction_failures: 2,
      persistence_failures: 1,
    });
    expect(failures).toEqual([
      {
        name: 'session eviction failed',
        tags: { area: 'persistence', stage: 'eviction', code: 'STORAGE_ERROR' },
      },
    ]);
    // Machine-readable lines, with the session where a person needs it.
    expect(lines.filter((line) => line.msg === 'session')).toHaveLength(8);
    expect(lines[0]).toMatchObject({
      level: 'info',
      msg: 'session',
      type: 'created',
      sessionId: 'session-one',
    });
  });

  it('counts each way a Game Master turn can end', () => {
    const { observer, metrics } = observed();
    const turns: Partial<GameMasterAudit>[] = [
      { outcome: 'APPLIED', saved: true, eventType: 'ZONE_CHANGE' },
      { outcome: 'NO_EVENT' },
      { outcome: 'SKIPPED', code: 'GAME_NOT_ACTIVE' },
      { outcome: 'FAILED', stage: 'PROPOSAL', code: 'TIMED_OUT' },
      { outcome: 'FAILED', stage: 'PROPOSAL', code: 'PROVIDER_TIMEOUT' },
      { outcome: 'FAILED', stage: 'PROPOSAL', code: 'INVALID_PROPOSAL' },
      { outcome: 'REJECTED', stage: 'SAFETY', code: 'UNSAFE' },
      { outcome: 'REJECTED', stage: 'STATE', code: 'INVALID_PLAYER' },
      { outcome: 'REJECTED', stage: 'APPLICATION', code: 'INVALID_EVENT' },
      { outcome: 'REJECTED', stage: 'SCHEMA', code: 'INVALID_PROPOSAL' },
    ];
    for (const turn of turns) observer.onGameMasterAudit(audit(turn));

    const { counters, timers } = metrics.read();
    expect(counters).toMatchObject({
      game_master_invocations: 10,
      game_master_successes: 2,
      game_master_skipped: 1,
      game_master_failures: 3,
      game_master_timeouts: 2,
      game_master_safety_rejections: 1,
      game_master_engine_rejections: 2,
      game_master_schema_rejections: 1,
      persistence_failures: 0,
    });
    expect(timers.game_master_turn_ms).toEqual({ count: 10, totalMs: 1_200, maxMs: 120 });
  });

  it('counts tool calls from the record of the turn', () => {
    const { observer, metrics } = observed();
    observer.onGameMasterAudit(
      audit({
        toolCalls: [
          { name: 'game_rules', ok: true, durationMs: 4 },
          { name: '(unknown)', ok: false, code: 'UNKNOWN_TOOL', durationMs: 1 },
          { name: 'game_history', ok: false, code: 'TOOL_TIMEOUT', durationMs: 2_000 },
        ],
      }),
    );
    expect(metrics.read().counters).toMatchObject({ tool_invocations: 3, tool_failures: 2 });
    expect(metrics.read().timers.tool_call_ms).toEqual({ count: 3, totalMs: 2_005, maxMs: 2_000 });
  });

  it('reports an applied event that could not be saved, without the session in the report', () => {
    const { observer, metrics, failures } = observed();
    observer.onGameMasterAudit(audit({ outcome: 'APPLIED', saved: false, code: 'STORAGE_ERROR' }));
    expect(metrics.read().counters.persistence_failures).toBe(1);
    expect(failures).toEqual([
      {
        name: 'game master event applied but not saved',
        tags: { area: 'persistence', stage: 'game_master_save', code: 'STORAGE_ERROR' },
      },
    ]);
    expect(JSON.stringify(failures)).not.toContain('session-one');
  });

  it('keeps the most recent records, a bounded number of them, oldest first', () => {
    const { observer } = observed();
    for (let index = 1; index <= 5; index += 1) {
      observer.onGameMasterAudit(audit({ invocationId: `gm-${String(index)}` }));
    }
    expect(observer.recentAudits().map((kept) => kept.invocationId)).toEqual([
      'gm-3',
      'gm-4',
      'gm-5',
    ]);
    // What is handed out is a copy.
    (observer.recentAudits() as GameMasterAudit[]).length = 0;
    expect(observer.recentAudits()).toHaveLength(3);
    expect(createObserver({ recentAudits: 0 }).recentAudits()).toEqual([]);
  });

  it('counts sockets coming and going', () => {
    const { observer, metrics, lines } = observed();
    observer.onSocketEvent({ type: 'opened' });
    observer.onSocketEvent({ type: 'attached' });
    observer.onSocketEvent({ type: 'opened' });
    observer.onSocketEvent({ type: 'refused', code: 'SESSION_NOT_FOUND' });
    observer.onSocketEvent({ type: 'closed' });
    expect(metrics.read().counters).toMatchObject({
      websocket_connections_opened: 2,
      websocket_connections_refused: 1,
      websocket_connections_closed: 1,
    });
    expect(lines.filter((line) => line.msg === 'socket')).toHaveLength(5);
  });

  it('reports an unexpected error with its tags, and logs where it happened but not what it said', () => {
    const { observer, metrics, lines, errors } = observed();
    const thrown = new Error(`LEAK_MARKER ${TOKEN} ${URI}`);
    observer.onUnexpectedError(thrown, { area: 'game_master', stage: 'turn', model: 'gemma3:4b' });

    expect(metrics.read().counters.unexpected_errors).toBe(1);
    expect(errors).toEqual([
      { error: thrown, tags: { area: 'game_master', stage: 'turn', model: 'gemma3:4b' } },
    ]);
    const line = lines.find((entry) => entry.msg === 'unexpected error');
    expect(line).toMatchObject({ level: 'error', area: 'game_master', stage: 'turn' });
    expect(JSON.stringify(lines)).not.toMatch(/LEAK_MARKER|hunter-two/);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it('works with nothing behind it, and is not disturbed by parts that throw', () => {
    const bare = createObserver();
    const broken = createObserver({
      metrics: {
        increment: () => {
          throw new Error('metrics broke');
        },
        observe: () => {
          throw new Error('metrics broke');
        },
        read: () => createMetrics().read(),
      },
      logger: createLogger({
        sink: () => {
          throw new Error('the log broke');
        },
      }),
      reporter: {
        captureError: () => {
          throw new Error('the reporter broke');
        },
        captureFailure: () => {
          throw new Error('the reporter broke');
        },
        flush: () => Promise.reject(new Error('the reporter broke')),
      },
    });
    for (const observer of [bare, broken]) {
      expect(() => {
        observer.onSessionEvent({
          type: 'eviction_failed',
          sessionId: 's',
          at: 1,
          code: 'STORAGE_ERROR',
        });
        observer.onGameMasterAudit(audit({ outcome: 'APPLIED', saved: false }));
        observer.onSocketEvent({ type: 'opened' });
        observer.onUnexpectedError(new Error('x'), { area: 'server' });
        observer.onFailure('x', { area: 'server' });
      }).not.toThrow();
    }
    expect(broken.recentAudits()).toHaveLength(1);
  });
});

describe('the configuration for reporting and tools', () => {
  it('has error reporting off unless it is switched on, and then needs to know where to send', () => {
    expect(parseErrorReportingConfig({})).toEqual({ ok: true, value: { enabled: false } });
    // An address that is set while reporting is off is ignored, not used.
    expect(parseErrorReportingConfig({ SENTRY_DSN: 'https://key@example.invalid/1' })).toEqual({
      ok: true,
      value: { enabled: false },
    });
    expect(
      parseErrorReportingConfig({
        SENTRY_ENABLED: 'true',
        SENTRY_DSN: 'https://key@example.invalid/1',
      }),
    ).toEqual({
      ok: true,
      value: { enabled: true, dsn: 'https://key@example.invalid/1', environment: 'development' },
    });
    expect(
      parseErrorReportingConfig({
        SENTRY_ENABLED: '1',
        SENTRY_DSN: 'https://key@example.invalid/1',
        SENTRY_ENVIRONMENT: 'staging',
      }),
    ).toMatchObject({ value: { environment: 'staging' } });
  });

  it('refuses a configuration that makes no sense, and never repeats a value', () => {
    for (const env of [
      { SENTRY_ENABLED: 'true' },
      { SENTRY_ENABLED: 'true', SENTRY_DSN: '   ' },
      { SENTRY_ENABLED: 'maybe' },
      {
        SENTRY_ENABLED: 'true',
        SENTRY_DSN: 'https://k@example.invalid/1',
        SENTRY_ENVIRONMENT: 'a b/c',
      },
    ]) {
      const parsed = parseErrorReportingConfig(env);
      expect(parsed.ok, JSON.stringify(env)).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.issues.join(' ')).toMatch(/SENTRY_/);
        expect(parsed.error.issues.join(' ')).not.toContain('example.invalid');
      }
    }
  });

  it('gives the Game Master no tools unless they are named', () => {
    expect(parseGameMasterConfig({}).ok && parseGameMasterConfig({})).toMatchObject({
      value: { tools: [] },
    });
    const parsed = parseGameMasterConfig({ GAME_MASTER_TOOLS: ' game_history , game_rules,, ' });
    expect(parsed.ok && parsed.value.tools).toEqual(['game_history', 'game_rules']);
  });
});

describe('where Sentry is', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(directory)
    .filter((name) => name.endsWith('.ts') && !name.includes('test'))
    .map((name) => [name, readFileSync(joinPath(directory, name), 'utf-8')] as const);

  it('is in one module, which nothing loads unless reporting is switched on', () => {
    const importers = sources
      .filter(([, source]) => /@sentry\//.test(source))
      .map(([name]) => name);
    expect(importers).toEqual(['sentry.ts']);
    // Nothing imports that module statically.
    for (const [name, source] of sources) {
      expect(source, name).not.toMatch(/from '\.\/sentry'/);
    }
    const loaders = sources.filter(([, source]) => /import\('\.\/sentry'\)/.test(source));
    expect(loaders.map(([name]) => name)).toEqual(['dev-sessions.ts', 'main.ts']);
    for (const [name, source] of loaders) {
      expect(source, name).toMatch(
        /reporting(\.value)?\.enabled\s*\?\s*\(await import\('\.\/sentry'\)\)/,
      );
      expect(source, name).toContain(': noopReporter;');
    }
    const dev = loaders[0]?.[1] ?? '';
    expect(dev).toMatch(/reporting\.value\.enabled\s*\?\s*\(await import\('\.\/sentry'\)\)/);
    expect(dev).toContain(': noopReporter;');
  });

  it('has every automatic integration off', () => {
    const sentry = sources.find(([name]) => name === 'sentry.ts')?.[1] ?? '';
    expect(sentry).toContain('defaultIntegrations: false');
    expect(sentry).toContain('integrations: []');
    expect(sentry).toContain('maxBreadcrumbs: 0');
    expect(sentry).toContain('tracesSampleRate: 0');
  });
});
