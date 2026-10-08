import * as Sentry from '@sentry/node';
import { type ErrorReporter, cleanTags, scrubText, toReportableError } from './reporting';

/**
 * The Sentry adapter for `ErrorReporter`.
 *
 * This is the only module that imports the Sentry SDK, and nothing imports this
 * module unless Sentry is switched on. With it off, the SDK is never loaded.
 *
 * The SDK is used for one thing: sending what the application reports. Its
 * automatic integrations are all turned off, so it does not hook the console,
 * outgoing requests, the process's error handlers or anything else, and it
 * records no breadcrumbs. It is told to collect no user information and no
 * request bodies.
 *
 * What is sent is narrowed twice. `captureError` and `captureFailure` send a
 * scrubbed error and tags from the fixed list. Then, whatever the SDK added,
 * `beforeSend` removes the user, the request, breadcrumbs, extra data, the host
 * name and any tag not on the list, and scrubs every piece of error text again.
 */

export interface SentryReporterOptions {
  readonly dsn: string;
  readonly environment: string;
  /** Replaces the network transport. For tests. */
  readonly transport?: NonNullable<Parameters<typeof Sentry.init>[0]>['transport'];
}

export function createSentryReporter(options: SentryReporterOptions): ErrorReporter {
  Sentry.init({
    dsn: options.dsn,
    environment: scrubText(options.environment).slice(0, 64),
    defaultIntegrations: false,
    integrations: [],
    dataCollection: { userInfo: false, httpBodies: [] },
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    ...(options.transport ? { transport: options.transport } : {}),
    beforeSend(event) {
      delete event.user;
      delete event.request;
      delete event.breadcrumbs;
      delete event.extra;
      delete event.server_name;
      delete event.modules;
      // Only what the application put there on purpose stays.
      event.tags = cleanTags(event.tags);
      event.contexts = {};
      if (typeof event.message === 'string') event.message = scrubText(event.message);
      for (const value of event.exception?.values ?? []) {
        if (typeof value.value === 'string') value.value = scrubText(value.value);
        for (const frame of value.stacktrace?.frames ?? []) {
          delete frame.vars;
          delete frame.pre_context;
          delete frame.context_line;
          delete frame.post_context;
        }
      }
      return event;
    },
  });

  return {
    captureError(error, tags) {
      Sentry.withScope((scope) => {
        scope.setTags(cleanTags(tags));
        Sentry.captureException(toReportableError(error));
      });
    },
    captureFailure(name, tags) {
      Sentry.withScope((scope) => {
        scope.setTags(cleanTags(tags));
        scope.setLevel('warning');
        Sentry.captureMessage(scrubText(name));
      });
    },
    async flush() {
      await Sentry.flush(2_000);
    },
  };
}
