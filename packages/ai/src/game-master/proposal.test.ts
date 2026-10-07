import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DERIVED_EVENT_KINDS,
  LIFECYCLE_EVENT_KINDS,
  OPTIONAL_EVENT_KINDS,
  getGameDefinition,
  listGameDefinitions,
} from '@touchgrass/game-definitions';
import { EXTERNAL_EVENT_SCHEMAS, gameEventSchema } from '@touchgrass/game-engine';
import {
  gameMasterProposalSchema,
  parseGameMasterProposal,
  proposalOutputSchemaFor,
} from './proposal';

const RATIONALE = 'The round has gone quiet and needs one small change.';
const tag = getGameDefinition('tag');

const zone = { type: 'ZONE_CHANGE', modifier: 'SAFE_ZONE', zone: 'the bench', durationSeconds: 45 };

describe('gameMasterProposalSchema', () => {
  it('accepts an external event with a rationale, and a decision to do nothing', () => {
    expect(gameMasterProposalSchema.safeParse({ rationale: RATIONALE, event: zone }).success).toBe(
      true,
    );
    expect(gameMasterProposalSchema.safeParse({ rationale: RATIONALE, event: null }).success).toBe(
      true,
    );
  });

  it('requires a rationale of a sensible length', () => {
    expect(gameMasterProposalSchema.safeParse({ event: null }).success).toBe(false);
    expect(gameMasterProposalSchema.safeParse({ rationale: 'ok', event: null }).success).toBe(
      false,
    );
    expect(
      gameMasterProposalSchema.safeParse({ rationale: 'x'.repeat(301), event: null }).success,
    ).toBe(false);
  });

  it('rejects any extra field', () => {
    expect(
      gameMasterProposalSchema.safeParse({ rationale: RATIONALE, event: null, score: 5 }).success,
    ).toBe(false);
  });

  it('reuses the engine event schemas: every proposed event is a valid engine event', () => {
    const parsed = gameMasterProposalSchema.parse({ rationale: RATIONALE, event: zone });
    expect(gameEventSchema.safeParse(parsed.event).success).toBe(true);
  });
});

describe('the external-event boundary', () => {
  it('has a schema for exactly the optional event kinds', () => {
    expect(Object.keys(EXTERNAL_EVENT_SCHEMAS).sort()).toEqual([...OPTIONAL_EVENT_KINDS].sort());
  });

  it.each([...LIFECYCLE_EVENT_KINDS, ...DERIVED_EVENT_KINDS])(
    'cannot express the engine-only event %s',
    (kind) => {
      expect(Object.keys(EXTERNAL_EVENT_SCHEMAS)).not.toContain(kind);
      const result = parseGameMasterProposal(
        { rationale: RATIONALE, event: { type: kind } },
        // Even for a definition that claimed to allow everything.
        { name: 'Any', allowedEventKinds: [...OPTIONAL_EVENT_KINDS] },
      );
      expect(result.ok).toBe(false);
    },
  );

  it('has no cause field on the external ROLE_CHANGE', () => {
    const assignments = [
      { playerId: 'p1', roleId: 'tagger' },
      { playerId: 'p0', roleId: 'runner' },
    ];
    const plain = { type: 'ROLE_CHANGE', assignments };
    const forged = {
      ...plain,
      cause: { reason: 'TAGGED', byPlayerId: 'p0', targetPlayerId: 'p1' },
    };
    expect(EXTERNAL_EVENT_SCHEMAS.ROLE_CHANGE.safeParse(plain).success).toBe(true);
    expect(EXTERNAL_EVENT_SCHEMAS.ROLE_CHANGE.safeParse(forged).success).toBe(false);
    // The engine's own schema does accept a cause; only the external one refuses it.
    expect(gameEventSchema.safeParse(forged).success).toBe(true);
  });
});

describe('parseGameMasterProposal', () => {
  it('returns the typed proposal', () => {
    const result = parseGameMasterProposal({ rationale: RATIONALE, event: zone }, tag);
    expect(result).toEqual({ ok: true, value: { rationale: RATIONALE, event: zone } });
  });

  it('names the field when an event is out of range', () => {
    const result = parseGameMasterProposal(
      { rationale: RATIONALE, event: { ...zone, durationSeconds: 99_999 } },
      tag,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.join(' ')).toMatch(/event\.durationSeconds/);
  });

  it('lists the kinds the game allows when the kind is wrong', () => {
    const result = parseGameMasterProposal(
      { rationale: RATIONALE, event: { type: 'RULE_MODIFIER' } },
      tag,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]).toContain(tag.allowedEventKinds.join(', '));
  });

  it('requires event to be present, even when it is null', () => {
    expect(parseGameMasterProposal({ rationale: RATIONALE }, tag).ok).toBe(false);
  });

  it('rejects input that is not an object', () => {
    for (const input of [null, 'ZONE_CHANGE', 42, [], undefined]) {
      expect(parseGameMasterProposal(input, tag).ok).toBe(false);
    }
  });
});

describe('proposalOutputSchemaFor', () => {
  it.each(listGameDefinitions())('$id: offers the model only its own event kinds', (definition) => {
    const json = JSON.stringify(
      z.toJSONSchema(proposalOutputSchemaFor(definition), {
        io: 'input',
        unrepresentable: 'any',
      }),
    );
    for (const kind of OPTIONAL_EVENT_KINDS) {
      expect(json.includes(`"${kind}"`)).toBe(definition.allowedEventKinds.includes(kind));
    }
    for (const kind of [...LIFECYCLE_EVENT_KINDS, ...DERIVED_EVENT_KINDS]) {
      expect(json).not.toContain(kind);
    }
  });

  it('agrees with parseGameMasterProposal on what a game accepts', () => {
    const schema = proposalOutputSchemaFor(tag);
    expect(schema.safeParse({ rationale: RATIONALE, event: zone }).success).toBe(true);
    expect(schema.safeParse({ rationale: RATIONALE, event: null }).success).toBe(true);
    expect(
      schema.safeParse({ rationale: RATIONALE, event: { type: 'TIME_EXTENSION', seconds: 30 } })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({
        rationale: RATIONALE,
        event: {
          type: 'RULE_MODIFIER',
          modifier: 'FREEZE_PERIOD',
          roleIds: ['runner'],
          durationSeconds: 30,
        },
      }).success,
    ).toBe(false);
  });
});
