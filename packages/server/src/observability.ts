import type { Logger } from '@touchgrass/shared';
import type { GameMasterAudit } from './game-master-turns';
import type { Metrics } from './metrics';
import { type ErrorReporter, type ReportTags, noopReporter } from './reporting';
import type { SessionLifecycleEvent } from './session-registry';

/**
 * One place where what happens in the server is counted, logged and reported.
 *
 * The parts of the server already say what they do: the registry emits session
 * events, the Game Master emits one record per turn, the listener says when a
 * socket comes and goes. This module listens to those and does three things
 * with each, all optional:
 *
 *   metrics    a fixed counter or timer is updated
 *   logger     one machine-readable line is written
 *   reporter   an unexpected error, or a failure worth a person's attention,
 *              is reported
 *
 * It adds no information of its own and decides nothing. Everything it handles
 * is already free of tokens, prompts, replies and game data, and it adds none.
 * A session id appears in log lines, where a person reading them needs it, and
 * never in a metric or a report.
 *
 * It also keeps the most recent Game Master records in memory, a bounded
 * number of them, for whoever asks. Nothing is written to a store.
 */

/** A socket coming or going at the listener. No address, no session. */
export interface SocketEvent {
  readonly type: 'opened' | 'attached' | 'refused' | 'closed';
  /** For `refused`: the protocol error it was sent. */
  readonly code?: string;
}

export interface ObservabilityOptions {
  readonly metrics?: Metrics;
  readonly logger?: Logger;
  readonly reporter?: ErrorReporter;
  /** How many recent Game Master records to keep. Default 200. */
  readonly recentAudits?: number;
}

export interface Observer {
  readonly onSessionEvent: (event: SessionLifecycleEvent) => void;
  readonly onGameMasterAudit: (audit: GameMasterAudit) => void;
  readonly onSocketEvent: (event: SocketEvent) => void;
  /** Something threw that was not expected to. */
  readonly onUnexpectedError: (error: unknown, tags: ReportTags) => void;
  /** Something expected went wrong and is worth a person's attention. */
  readonly onFailure: (name: string, tags: ReportTags) => void;
  /** The most recent Game Master records, oldest first. */
  readonly recentAudits: () => readonly GameMasterAudit[];
}

export function createObserver(options: ObservabilityOptions = {}): Observer {
  const { metrics, logger } = options;
  const reporter = options.reporter ?? noopReporter;
  const keep = Math.max(0, options.recentAudits ?? 200);
  const audits: GameMasterAudit[] = [];

  /** Nothing here may disturb what it observes. */
  const quietly = (work: () => void): void => {
    try {
      work();
    } catch {
      // A logger, a metric or a reporter that fails changes nothing.
    }
  };

  const onFailure = (name: string, tags: ReportTags): void => {
    quietly(() => logger?.warn(name, { ...tags }));
    quietly(() => {
      reporter.captureFailure(name, tags);
    });
  };

  return {
    onSessionEvent(event) {
      quietly(() => {
        if (event.type === 'created') metrics?.increment('session_creates');
        if (event.type === 'loaded') metrics?.increment('session_loads');
        if (event.type === 'evicted') metrics?.increment('session_evictions');
        if (event.type === 'unloaded') metrics?.increment('session_unloads');
        if (event.type === 'eviction_failed') metrics?.increment('session_eviction_failures');
      });
      quietly(() => logger?.info('session', { ...event }));
      // A session that would not be saved is a persistence failure. One that
      // was simply in use is not a failure at all.
      if (event.type === 'eviction_failed' && event.code !== 'SESSION_IN_USE') {
        quietly(() => metrics?.increment('persistence_failures'));
        onFailure('session eviction failed', {
          area: 'persistence',
          stage: 'eviction',
          ...(event.code ? { code: event.code } : {}),
        });
      }
    },

    onGameMasterAudit(audit) {
      quietly(() => {
        if (keep === 0) return;
        audits.push(audit);
        if (audits.length > keep) audits.splice(0, audits.length - keep);
      });
      quietly(() => {
        if (!metrics) return;
        metrics.increment('game_master_invocations');
        metrics.observe('game_master_turn_ms', audit.durationMs);
        if (audit.outcome === 'APPLIED' || audit.outcome === 'NO_EVENT') {
          metrics.increment('game_master_successes');
        }
        if (audit.outcome === 'SKIPPED') metrics.increment('game_master_skipped');
        if (audit.outcome === 'FAILED') {
          metrics.increment('game_master_failures');
          if (audit.code === 'TIMED_OUT' || audit.code === 'PROVIDER_TIMEOUT') {
            metrics.increment('game_master_timeouts');
          }
        }
        if (audit.outcome === 'REJECTED') {
          if (audit.stage === 'SAFETY') metrics.increment('game_master_safety_rejections');
          if (audit.stage === 'SCHEMA') metrics.increment('game_master_schema_rejections');
          if (audit.stage === 'STATE' || audit.stage === 'APPLICATION') {
            metrics.increment('game_master_engine_rejections');
          }
        }
        for (const call of audit.toolCalls ?? []) {
          metrics.increment('tool_invocations');
          metrics.observe('tool_call_ms', call.durationMs);
          if (!call.ok) metrics.increment('tool_failures');
        }
      });
      quietly(() => logger?.info('game_master_turn', { ...audit }));
      if (audit.outcome === 'APPLIED' && audit.saved === false) {
        quietly(() => metrics?.increment('persistence_failures'));
        onFailure('game master event applied but not saved', {
          area: 'persistence',
          stage: 'game_master_save',
          ...(audit.code ? { code: audit.code } : {}),
        });
      }
    },

    onSocketEvent(event) {
      quietly(() => {
        if (event.type === 'opened') metrics?.increment('websocket_connections_opened');
        if (event.type === 'refused') metrics?.increment('websocket_connections_refused');
        if (event.type === 'closed') metrics?.increment('websocket_connections_closed');
      });
      quietly(() => logger?.debug('socket', { ...event }));
    },

    onUnexpectedError(error, tags) {
      quietly(() => metrics?.increment('unexpected_errors'));
      // The log line names where it happened and never the error's own text,
      // which may contain anything. The scrubbed error goes to the reporter.
      quietly(() => logger?.error('unexpected error', { ...tags }));
      quietly(() => {
        reporter.captureError(error, tags);
      });
    },

    onFailure,

    recentAudits: () => [...audits],
  };
}
