import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modelFor } from '../src/groups.js';
import {
  call,
  confirmed,
  connect,
  dataOf,
  FakeCardDav,
  textOf,
  vcard,
  type Connected,
} from './harness.js';

const ADA = vcard({ UID: 'uid-ada', FN: 'Ada Lovelace' });
const GRACE = vcard({ UID: 'uid-grace', FN: 'Grace Hopper' });
const APPLE_GROUP = vcard({
  UID: 'uid-team',
  FN: 'Pioneers',
  'X-ADDRESSBOOKSERVER-KIND': 'group',
  'X-ADDRESSBOOKSERVER-MEMBER': 'urn:uuid:uid-ada',
});

let fake: FakeCardDav;
let session: Connected;

async function open(
  elicit?: 'accept' | 'decline',
  options: ConstructorParameters<typeof FakeCardDav>[0] = {}
): Promise<void> {
  fake = new FakeCardDav({
    books: [
      {
        name: 'work',
        displayName: 'Work',
        resources: {
          'ada.vcf': ADA,
          'grace.vcf': GRACE,
          'team.vcf': APPLE_GROUP,
        },
      },
      { name: 'private', displayName: 'Private' },
    ],
    ...options,
  });
  fake.install();
  session = await connect({}, elicit);
}

async function contactIds(): Promise<Record<string, string>> {
  const listed = dataOf(await call(session, 'list_contacts'));
  const out: Record<string, string> = {};
  for (const contact of listed.contacts as Record<string, unknown>[]) {
    out[contact.formatted_name as string] = contact.id as string;
  }
  return out;
}

async function groupId(): Promise<string> {
  const groups = dataOf(await call(session, 'list_groups'));
  const [first] = groups.groups as Record<string, unknown>[];
  return first?.id as string;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(async () => {
  await session?.close();
  vi.unstubAllGlobals();
});

describe('modelFor', () => {
  it('follows the groups the book already has', () => {
    // A group written in the other convention is invisible in the client the
    // person is actually looking at.
    const apple = [{ model: 'apple' as const }] as never;
    const rfc = [{ model: 'rfc' as const }] as never;
    expect(modelFor(apple, '4.0')).toBe('apple');
    expect(modelFor(rfc, '3.0')).toBe('rfc');
  });

  it('falls back to the card version when the book has no groups', () => {
    expect(modelFor([], '3.0')).toBe('apple');
    expect(modelFor([], '4.0')).toBe('rfc');
  });

  it('picks by version when the book already mixes both', () => {
    const mixed = [
      { model: 'apple' as const },
      { model: 'rfc' as const },
    ] as never;
    expect(modelFor(mixed, '3.0')).toBe('apple');
  });
});

describe('list_groups', () => {
  it('finds the group and reports its size without resolving members', async () => {
    await open();
    const data = dataOf(await call(session, 'list_groups'));
    expect(data.count).toBe(1);
    const [group] = data.groups as Record<string, unknown>[];
    expect(group?.name).toBe('Pioneers');
    expect(group?.model).toBe('apple');
    expect(group?.member_count).toBe(1);
    // Resolving is one extra request per book, and get_group is where a caller
    // has said they want the names.
    const members = group?.members as Record<string, unknown>[];
    expect(members[0]?.formatted_name).toBeUndefined();
  });

  it('finds a vCard 4 group too', async () => {
    await open();
    fake.seed(
      'work',
      'modern.vcf',
      vcard(
        {
          UID: 'uid-modern',
          FN: 'Moderns',
          KIND: 'group',
          MEMBER: 'urn:uuid:uid-grace',
        },
        '4.0'
      )
    );
    const data = dataOf(await call(session, 'list_groups'));
    expect(data.count).toBe(2);
    const models = (data.groups as Record<string, unknown>[]).map(
      (group) => group.model
    );
    expect(models.sort()).toEqual(['apple', 'rfc']);
  });
});

describe('get_group', () => {
  it('resolves members that live in the same book', async () => {
    await open();
    const data = dataOf(
      await call(session, 'get_group', { id: await groupId() })
    );
    const group = data.group as Record<string, unknown>;
    const members = group.members as Record<string, unknown>[];
    expect(members).toHaveLength(1);
    expect(members[0]?.formatted_name).toBe('Ada Lovelace');
    expect(members[0]?.uid).toBe('uid-ada');
    expect(members[0]?.id).toBeDefined();
    expect(data.unresolved).toBe(0);
  });

  it('reports a member it cannot resolve rather than dropping it', async () => {
    await open();
    fake.seed(
      'work',
      'team.vcf',
      vcard({
        UID: 'uid-team',
        FN: 'Pioneers',
        'X-ADDRESSBOOKSERVER-KIND': 'group',
        'X-ADDRESSBOOKSERVER-MEMBER': 'urn:uuid:uid-gone',
      })
    );
    const data = dataOf(
      await call(session, 'get_group', { id: await groupId() })
    );
    expect(data.unresolved).toBe(1);
    const members = (data.group as Record<string, unknown>).members as Record<
      string,
      unknown
    >[];
    expect(members[0]?.reference).toBe('urn:uuid:uid-gone');
    expect(members[0]?.id).toBeUndefined();
    expect(JSON.stringify(data.notes)).toContain('could not be resolved');
  });

  it('refuses a contact id and names the tool that handles it', async () => {
    await open();
    const ids = await contactIds();
    const result = await call(session, 'get_group', {
      id: ids['Ada Lovelace'],
    });
    expect(textOf(result)).toContain('names a contact, not a group');
  });
});

describe('create_group', () => {
  it('creates a group in the convention the book already uses', async () => {
    await open();
    const ids = await contactIds();
    const data = dataOf(
      await call(session, 'create_group', {
        address_book: 'work',
        name: 'Engineers',
        members: [ids['Grace Hopper']],
      })
    );
    expect(data.created).toBe(true);
    const created = fake
      .names('work')
      .map((name) => fake.stored('work', name) ?? '')
      .find((stored) => stored.includes('FN:Engineers'));
    expect(created).toContain('X-ADDRESSBOOKSERVER-KIND:group');
    expect(created).toContain('X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:uid-grace');
    // Anchored to a line: `X-ADDRESSBOOKSERVER-KIND:group` contains the
    // substring `KIND:group`, so a bare `not.toContain` never fails.
    expect(created?.split('\r\n')).not.toContain('KIND:group');
  });

  it('picks a convention and says so when the book has no groups yet', async () => {
    await open();
    const data = dataOf(
      await call(session, 'create_group', {
        address_book: 'private',
        name: 'Empty',
      })
    );
    expect(JSON.stringify(data.notes)).toContain('had no groups yet');
  });

  it('leaves out an id from another address book and says how many', async () => {
    // A group can only contain cards from the book it lives in — a reference
    // to another book resolves to nothing in every client.
    await open();
    const ids = await contactIds();
    const data = dataOf(
      await call(session, 'create_group', {
        address_book: 'private',
        name: 'Cross',
        members: [ids['Ada Lovelace']],
      })
    );
    expect(JSON.stringify(data.notes)).toContain('not in this address book');
    expect((data.group as Record<string, unknown>).member_count).toBe(0);
  });

  it('is not guarded', async () => {
    await open('accept');
    await call(session, 'create_group', {
      address_book: 'private',
      name: 'Unasked',
    });
    expect(session.prompts).toHaveLength(0);
  });
});

describe('update_group', () => {
  it('adds a member and asks first', async () => {
    await open('accept');
    const ids = await contactIds();
    const data = dataOf(
      await call(session, 'update_group', {
        id: await groupId(),
        add_members: [ids['Grace Hopper']],
      })
    );
    expect(data.added).toBe(1);
    expect(data.removed).toBe(0);
    expect(fake.stored('work', 'team.vcf')).toContain('urn:uuid:uid-grace');
    expect(session.prompts).toHaveLength(1);
  });

  it('removes a member without deleting the contact', async () => {
    await open('accept');
    const ids = await contactIds();
    const data = dataOf(
      await call(session, 'update_group', {
        id: await groupId(),
        remove_members: [ids['Ada Lovelace']],
      })
    );
    expect(data.removed).toBe(1);
    expect(fake.stored('work', 'team.vcf')).not.toContain('urn:uuid:uid-ada');
    // The card itself is untouched.
    expect(fake.stored('work', 'ada.vcf')).toContain('FN:Ada Lovelace');
    expect(session.prompts[0]).toContain('remove 1 member');
  });

  it('replaces the membership outright with set_members', async () => {
    await open('accept');
    const ids = await contactIds();
    const data = dataOf(
      await call(session, 'update_group', {
        id: await groupId(),
        set_members: [ids['Grace Hopper']],
      })
    );
    expect(data.added).toBe(1);
    expect(data.removed).toBe(1);
    expect(fake.stored('work', 'team.vcf')).not.toContain('uid-ada');
  });

  it('refuses set_members together with a delta', async () => {
    await open('accept');
    const result = await call(session, 'update_group', {
      id: await groupId(),
      set_members: [],
      add_members: [],
    });
    expect(textOf(result)).toContain('not both');
  });

  it('refuses when nothing was named', async () => {
    await open('accept');
    expect(
      textOf(await call(session, 'update_group', { id: await groupId() }))
    ).toContain('nothing to update');
  });

  it('renames a group', async () => {
    await open('accept');
    await call(session, 'update_group', {
      id: await groupId(),
      name: 'Renamed',
    });
    expect(fake.stored('work', 'team.vcf')).toContain('FN:Renamed');
  });

  it('binds the token to the membership the write would produce', async () => {
    await open();
    const ids = await contactIds();
    const id = await groupId();
    const first = await call(session, 'update_group', {
      id,
      add_members: [ids['Grace Hopper']],
    });
    const token = /confirm_token="([0-9a-f]+)"/.exec(textOf(first))?.[1];
    // A token issued for "add Grace" must not execute "remove Ada".
    const result = await call(session, 'update_group', {
      id,
      remove_members: [ids['Ada Lovelace']],
      confirm_token: token,
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(fake.stored('work', 'team.vcf')).toContain('uid-ada');
  });

  it('changes nothing when declined', async () => {
    await open('decline');
    await call(session, 'update_group', {
      id: await groupId(),
      name: 'Nope',
    });
    expect(fake.stored('work', 'team.vcf')).toContain('FN:Pioneers');
  });
});

describe('delete_group', () => {
  it('removes the group and leaves the contacts alone', async () => {
    await open('accept');
    const data = dataOf(
      await call(session, 'delete_group', { id: await groupId() })
    );
    expect(data.deleted).toBe(true);
    expect(data.members_released).toBe(1);
    expect(fake.names('work').sort()).toEqual(['ada.vcf', 'grace.vcf']);
    expect(session.prompts[0]).toContain('delete a group of 1 contact');
  });

  it('refuses a contact id', async () => {
    await open('accept');
    const ids = await contactIds();
    expect(
      textOf(await call(session, 'delete_group', { id: ids['Ada Lovelace'] }))
    ).toContain('names a contact, not a group');
  });

  it('deletes nothing on the first call of the token path', async () => {
    await open();
    const id = await groupId();
    await call(session, 'delete_group', { id });
    expect(fake.names('work')).toContain('team.vcf');
    await confirmed(session, 'delete_group', { id });
    expect(fake.names('work')).not.toContain('team.vcf');
  });
});
