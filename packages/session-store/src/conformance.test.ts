import { describeSessionStore } from './conformance';
import { InMemorySessionStore } from './in-memory';
import { MongoSessionStore } from './mongodb';
import { bsonCollection } from './test-support';

/**
 * The same contract, run against each implementation.
 *
 * The MongoDB adapter is run here over a collection that keeps documents as
 * BSON bytes, so this needs no database. The same suite runs against a real
 * MongoDB server in mongodb.integration.test.ts, when one is configured.
 */

describeSessionStore('InMemorySessionStore', () => new InMemorySessionStore());

describeSessionStore(
  'MongoSessionStore over BSON documents',
  () => new MongoSessionStore(() => bsonCollection().collection),
);
