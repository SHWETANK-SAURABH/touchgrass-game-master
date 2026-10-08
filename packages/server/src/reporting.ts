/**
 * Reporting errors to whoever monitors them.
 *
 * The application reports through this interface and knows nothing of what is
 * behind it. By default nothing is: the reporter does nothing, and everything
 * works exactly as it does without one. An adapter for an error-monitoring
 * service can be put behind it; see `sentry.ts`.
 *
 * Two kinds of thing are reported:
 *
 *   an error     something threw that was not expected to
 *   a failure    something expected went wrong, and has a stable code
 *
 * A report carries tags from a short fixed list, with short plain values. It
 * never carries a session id, a player, a token, a prompt, a reply, or any part
 * of a game. Error text is scrubbed before it leaves: see `scrubText`.
 */

/** The only tags a report may carry. None of them identifies a session or a person. */
export const REPORT_TAG_NAMES = [
  /** Which part of the application: game_master, tool, persistence, realtime, server. */
  'area',
  /** The step within it: a pipeline stage or a lifecycle step. */
  'stage',
  /** A stable error or rejection code. */
  'code',
  'provider',
  'model',
  /** The name of a listed tool. */
  'tool',
] as const;
export type ReportTagName = (typeof REPORT_TAG_NAMES)[number];
export type ReportTags = Readonly<Partial<Record<ReportTagName, string>>>;

export interface ErrorReporter {
  /** Something threw that was not expected to. */
  readonly captureError: (error: unknown, tags?: ReportTags) => void;
  /** Something expected went wrong. `name` is a fixed phrase, never built from data. */
  readonly captureFailure: (name: string, tags?: ReportTags) => void;
  /** Waits for what has been reported to be sent, up to a limit. */
  readonly flush: () => Promise<void>;
}

/** A reporter that reports nothing. The default. */
export const noopReporter: ErrorReporter = {
  captureError: () => undefined,
  captureFailure: () => undefined,
  flush: () => Promise.resolve(),
};

const MAX_TEXT = 300;
const MAX_TAG = 64;

/**
 * Removes from a piece of text what must not leave the process:
 *
 *   - anything that looks like an address with a scheme (a connection string
 *     can carry a user name and a password);
 *   - any long run of letters, digits, `-` and `_` (a bearer token, a key, an
 *     id that names a session or a player);
 *   - anything after the first few hundred characters.
 *
 * It is deliberately blunt. A report loses detail; it does not leak.
 */
export function scrubText(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '[address]')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]')
    .slice(0, MAX_TEXT);
}

/** The tags that are on the list, with values short and plain enough to be tags. */
export function cleanTags(tags: ReportTags | undefined): Partial<Record<ReportTagName, string>> {
  const clean: Partial<Record<ReportTagName, string>> = {};
  for (const name of REPORT_TAG_NAMES) {
    const value = tags?.[name];
    if (typeof value !== 'string' || value === '') continue;
    clean[name] = scrubText(value)
      .replace(/[^A-Za-z0-9_.:()[\] -]/g, '_')
      .slice(0, MAX_TAG);
  }
  return clean;
}

/**
 * An error that is safe to send: the same kind of error, with its text and its
 * trace scrubbed, and nothing else that was attached to the original.
 */
export function toReportableError(error: unknown): Error {
  const original =
    error instanceof Error ? error : new Error('A value that is not an error was thrown.');
  const safe = new Error(scrubText(original.message));
  safe.name = /^[A-Za-z]{1,40}$/.test(original.name) ? original.name : 'Error';
  if (typeof original.stack === 'string') {
    safe.stack = original.stack
      .split('\n')
      .slice(0, 12)
      .map((line) => scrubText(line))
      .join('\n');
  }
  return safe;
}
