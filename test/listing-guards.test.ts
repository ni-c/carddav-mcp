import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  call,
  connect,
  dataOf,
  FakeCardDav,
  vcard,
  type Connected,
} from './harness.js';

/**
 * A card that parses and then fails on the read.
 *
 * The parser is lazy: a value it cannot decode surfaces on `getFirstValue()`,
 * not on `parse()`. `list_contacts` has guarded parse and shape together since
 * 0.1.1; `list_groups` guarded the parse only, so one such card took the whole
 * listing down where an unparseable one was merely counted. The two guards
 * behind the search re-filter and the member index had the same shape.
 *
 * No card in the fixture set reaches that path today, because `propertyValue`
 * catches the lazy throw at the source. The mock stands in for whichever
 * future path does, and pins the contract: one bad card among many is a
 * counted omission, never an empty answer.
 */

vi.mock('../src/shape.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shape.js')>();
  return {
    ...actual,
    shapeGroup: (...args: Parameters<typeof actual.shapeGroup>) => {
      if (args[0].getFirstPropertyValue('fn') === 'Broken') {
        throw new TypeError('this card shapes badly');
      }
      return actual.shapeGroup(...args);
    },
  };
});

const GOOD = vcard({
  UID: 'uid-good',
  FN: 'Pioneers',
  'X-ADDRESSBOOKSERVER-KIND': 'group',
  'X-ADDRESSBOOKSERVER-MEMBER': 'urn:uuid:uid-ada',
});

const BROKEN = vcard({
  UID: 'uid-broken',
  FN: 'Broken',
  'X-ADDRESSBOOKSERVER-KIND': 'group',
});

let session: Connected;

afterEach(async () => {
  await session?.close();
  vi.unstubAllGlobals();
});

describe('list_groups under a card that shapes badly', () => {
  it('still lists the others and counts the one it left out', async () => {
    const fake = new FakeCardDav({
      books: [
        {
          name: 'work',
          displayName: 'Work',
          resources: { 'good.vcf': GOOD, 'broken.vcf': BROKEN },
        },
      ],
    });
    fake.install();
    session = await connect({});

    const data = dataOf(await call(session, 'list_groups'));
    expect(data.count).toBe(1);
    const [group] = data.groups as Record<string, unknown>[];
    expect(group?.name).toBe('Pioneers');
    expect(data.notes).toEqual([
      '1 card(s) could not be read and were left out.',
    ]);
  });
});
