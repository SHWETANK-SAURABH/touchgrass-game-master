import { type Result, err } from '@touchgrass/shared';
import { InMemorySessionStore, type SessionStoreError } from '@touchgrass/session-store';
import type { ClosableSessionStore } from './persistent-server';
import { CODE } from './test-support';

/**
 * Helpers for the tests that use real sockets against a session server: a
 * store whose calls can be held, and a client. Not exported from the package.
 */

const STORAGE_ERROR: SessionStoreError = {
  code: 'STORAGE_ERROR',
  message: 'LEAK_MARKER the database at example-host.invalid is away.',
};

type Operation = 'save' | 'load';

export function heldStore(inner = new InMemorySessionStore()) {
  const calls = { save: 0, load: 0, delete: 0, close: 0 };
  const events: string[] = [];
  const holding = new Set<Operation>();
  const held: { operation: Operation; sessionId: string; finish(): void }[] = [];
  const failing = { save: new Set<string>(), load: new Set<string>() };
  let closed = false;

  const gate = <T>(
    operation: Operation,
    sessionId: string,
    run: () => Promise<Result<T, SessionStoreError>>,
  ): Promise<Result<T, SessionStoreError>> => {
    calls[operation] += 1;
    const perform = async (): Promise<Result<T, SessionStoreError>> => {
      const result = closed || failing[operation].has(sessionId) ? err(STORAGE_ERROR) : await run();
      events.push(`${operation}:${sessionId}:${result.ok ? 'end' : 'failed'}`);
      return result;
    };
    if (!holding.has(operation)) return perform();
    return new Promise((resolve) => {
      const call = {
        operation,
        sessionId,
        finish() {
          held.splice(held.indexOf(call), 1);
          void perform().then(resolve);
        },
      };
      held.push(call);
    });
  };

  const store: ClosableSessionStore = {
    save: (snapshot) => gate('save', snapshot.sessionId, () => inner.save(snapshot)),
    load: (sessionId) => gate('load', sessionId, () => inner.load(sessionId)),
    delete: (sessionId) => {
      calls.delete += 1;
      return inner.delete(sessionId);
    },
    close() {
      calls.close += 1;
      events.push('store.close');
      closed = true;
      return Promise.resolve();
    },
  };
  return {
    store,
    inner,
    calls,
    events,
    held,
    failing,
    hold: (...operations: Operation[]): void => {
      for (const operation of operations) holding.add(operation);
    },
    release: (...operations: Operation[]): void => {
      for (const operation of operations) holding.delete(operation);
    },
  };
}

/** What a client was sent, decoded. */
export interface Message {
  type: string;
  code?: string;
  playerId?: string;
  token?: string;
  state?: { id: string; status: string; players: { displayName: string }[] };
}

/** A client that queues what it receives so a test can await the next message. */
export class Client {
  private readonly queue: Message[] = [];
  private readonly waiting: ((message: Message) => void)[] = [];
  readonly raw: string[] = [];
  readonly closed: Promise<void>;

  private constructor(readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const text = String(event.data);
      this.raw.push(text);
      const message = JSON.parse(text) as Message;
      const next = this.waiting.shift();
      if (next) next(message);
      else this.queue.push(message);
    });
    this.closed = new Promise((resolve) => {
      socket.addEventListener('close', () => {
        resolve();
      });
    });
  }

  /** Connects to a path as it is given. */
  static at(port: number, path: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      const client = new Client(socket);
      socket.addEventListener('open', () => {
        resolve(client);
      });
      socket.addEventListener('error', () => {
        reject(new Error('the socket could not connect'));
      });
    });
  }

  static open(port: number, sessionId: string): Promise<Client> {
    return Client.at(port, `/sessions/${encodeURIComponent(sessionId)}`);
  }

  send(message: unknown): void {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  next(): Promise<Message> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  pending(): number {
    return this.queue.length;
  }

  async join(displayName: string): Promise<{ playerId: string; token: string; sessionId: string }> {
    this.send({ type: 'join', joinCode: CODE, displayName });
    const message = await this.next();
    if (message.type !== 'joined' || !message.playerId || !message.token || !message.state) {
      throw new Error(`expected joined, got ${message.type}`);
    }
    return { playerId: message.playerId, token: message.token, sessionId: message.state.id };
  }
}

/** Waits until the server has processed everything this client has sent so far. */
export async function settled(client: Client): Promise<void> {
  client.send('?');
  for (;;) {
    const message = await client.next();
    if (message.type === 'error' && message.code === 'BAD_MESSAGE') return;
  }
}

/** Waits, a turn of the event loop at a time, for something the server does on its own. */
export async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2_000; turn += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('the condition never became true');
}

export const SESSION_CLOSED = { type: 'error', code: 'SESSION_CLOSED' };
export const READY = { type: 'action', intent: { type: 'PLAYER_READY' } };
