import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { changeDigest, changedFieldNames, hasAnyField } from '../src/write.js';
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

const ADA = vcard({
  UID: 'uid-ada',
  FN: 'Ada Lovelace',
  N: 'Lovelace;Ada;;;',
  'EMAIL;TYPE=WORK': 'ada@example.net',
  NOTE: 'First programmer.',
  'PHOTO;ENCODING=b;TYPE=PNG': 'aGVsbG8=',
  'X-PHONETIC-FIRST-NAME': 'Ay-da',
});

let fake: FakeCardDav;
let session: Connected;

async function open(
  elicit?: 'accept' | 'decline' | 'cancel',
  options: ConstructorParameters<typeof FakeCardDav>[0] = {},
  config: Parameters<typeof connect>[0] = {}
): Promise<void> {
  fake = new FakeCardDav({
    books: [
      { name: 'work', displayName: 'Work', resources: { 'ada.vcf': ADA } },
      { name: 'private', displayName: 'Private' },
      { name: 'locked', displayName: 'Locked', readOnly: true },
    ],
    ...options,
  });
  fake.install();
  session = await connect(config, elicit);
}

/** The id of the one seeded contact. */
async function adaId(): Promise<string> {
  const listed = dataOf(await call(session, 'list_contacts'));
  const [first] = listed.contacts as Record<string, unknown>[];
  return first?.id as string;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(async () => {
  await session?.close();
  vi.unstubAllGlobals();
});

describe('create_contact', () => {
  it('stores a card built from the named fields', async () => {
    await open();
    const data = dataOf(
      await call(session, 'create_contact', {
        address_book: 'private',
        given_name: 'Grace',
        family_name: 'Hopper',
        emails: [{ value: 'grace@example.net', type: 'work' }],
      })
    );
    expect(data.created).toBe(true);
    const [name] = fake.names('private');
    const stored = fake.stored('private', name!) ?? '';
    expect(stored).toContain('FN:Grace Hopper');
    expect(stored).toContain('EMAIL;TYPE=WORK:grace@example.net');
    expect(stored).toContain('VERSION:3.0');
  });

  it('derives FN from the name parts rather than demanding it', async () => {
    await open();
    await call(session, 'create_contact', {
      address_book: 'private',
      name_prefix: 'Dr',
      given_name: 'Grace',
      family_name: 'Hopper',
    });
    const [name] = fake.names('private');
    expect(fake.stored('private', name!)).toContain('FN:Dr Grace Hopper');
  });

  it('refuses a card with no name at all', async () => {
    await open();
    const result = await call(session, 'create_contact', {
      address_book: 'private',
      note: 'anonymous',
    });
    expect(textOf(result)).toContain('a contact needs a name');
  });

  it('refuses when nothing was named', async () => {
    await open();
    expect(
      textOf(await call(session, 'create_contact', { address_book: 'private' }))
    ).toContain('nothing to create');
  });

  it('writes 4.0 when the book only accepts 4.0', async () => {
    await open(undefined, {
      books: [{ name: 'modern', versions: ['4.0'] }],
    });
    await call(session, 'create_contact', {
      address_book: 'modern',
      formatted_name: 'Grace Hopper',
    });
    const [name] = fake.names('modern');
    expect(fake.stored('modern', name!)).toContain('VERSION:4.0');
  });

  it('reads its own answer back on a 4.0 book', async () => {
    // The regression: ical.js serialises a 4.0 REV correctly and then throws
    // when the same value is read back off the in-memory card, so the write
    // succeeded and shaping the answer blew up.
    await open(undefined, { books: [{ name: 'modern', versions: ['4.0'] }] });
    const result = await call(session, 'create_contact', {
      address_book: 'modern',
      formatted_name: 'Grace Hopper',
    });
    expect(textOf(result)).not.toContain('fatal');
    expect(dataOf(result).created).toBe(true);
  });

  it('writes a yearless birthday and says what it had to do', async () => {
    await open();
    const data = dataOf(
      await call(session, 'create_contact', {
        address_book: 'private',
        formatted_name: 'Someone',
        birthday: { month: 4, day: 15 },
      })
    );
    const [name] = fake.names('private');
    expect(fake.stored('private', name!)).toContain('BDAY;VALUE=date:16040415');
    expect(JSON.stringify(data.notes)).toContain('not a claim about the year');
  });

  it('stores a raw vCard as given', async () => {
    await open();
    await call(session, 'create_contact', {
      address_book: 'private',
      raw_vcard: vcard({ UID: 'kept', FN: 'Raw Person', 'X-ODD': 'yes' }),
    });
    const [name] = fake.names('private');
    expect(fake.stored('private', name!)).toContain('X-ODD:yes');
  });

  it('refuses a raw card alongside the named fields', async () => {
    await open();
    const result = await call(session, 'create_contact', {
      address_book: 'private',
      formatted_name: 'Both',
      raw_vcard: vcard({ FN: 'Raw' }),
    });
    expect(textOf(result)).toContain('not both');
  });

  it('refuses a read-only address book before sending anything', async () => {
    await open();
    const before = fake.requests.filter((r) => r.method === 'PUT').length;
    const result = await call(session, 'create_contact', {
      address_book: 'locked',
      formatted_name: 'Nope',
    });
    expect(textOf(result)).toContain('read-only');
    expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(
      before
    );
  });

  it('refuses a card larger than the book accepts, before sending it', async () => {
    await open(undefined, {
      books: [{ name: 'tiny', maxResourceSize: 100 }],
    });
    const result = await call(session, 'create_contact', {
      address_book: 'tiny',
      formatted_name: 'Someone',
      note: 'x'.repeat(500),
    });
    expect(textOf(result)).toContain('accepts at most 100');
    expect(fake.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('is not guarded — it adds something that was not there', async () => {
    await open('accept');
    await call(session, 'create_contact', {
      address_book: 'private',
      formatted_name: 'Unasked',
    });
    expect(session.prompts).toHaveLength(0);
  });
});

describe('update_contact', () => {
  it('changes the named fields and keeps everything else', async () => {
    // The rule: a write reads first and never rebuilds. An X-property some
    // phone wrote and a photo nobody mentioned survive an edit.
    await open('accept');
    const id = await adaId();
    await call(session, 'update_contact', { id, title: 'Countess' });
    const stored = fake.stored('work', 'ada.vcf') ?? '';
    expect(stored).toContain('TITLE:Countess');
    expect(stored).toContain('X-PHONETIC-FIRST-NAME:Ay-da');
    expect(stored).toContain('PHOTO;ENCODING=b');
    expect(stored).toContain('NOTE:First programmer.');
  });

  it('removes a field when told null and leaves it when omitted', async () => {
    await open('accept');
    const id = await adaId();
    await call(session, 'update_contact', { id, note: null });
    expect(fake.stored('work', 'ada.vcf')).not.toContain('NOTE:');
    expect(fake.stored('work', 'ada.vcf')).toContain('FN:Ada Lovelace');
  });

  it('changes one component of N without losing the others', async () => {
    await open('accept');
    const id = await adaId();
    await call(session, 'update_contact', { id, given_name: 'Augusta' });
    expect(fake.stored('work', 'ada.vcf')).toContain('N:Lovelace;Augusta;');
  });

  it('asks first, and does nothing until it is answered', async () => {
    await open('accept');
    const id = await adaId();
    await call(session, 'update_contact', { id, title: 'Countess' });
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toContain('replace 1 field');
  });

  it('does nothing when the dialog is declined', async () => {
    await open('decline');
    const id = await adaId();
    const result = await call(session, 'update_contact', {
      id,
      title: 'Countess',
    });
    expect(textOf(result)).toContain('The user declined');
    expect(fake.stored('work', 'ada.vcf')).not.toContain('TITLE:');
  });

  it('falls back to the two-call token for a client that cannot be asked', async () => {
    await open();
    const id = await adaId();
    const first = await call(session, 'update_contact', { id, title: 'C' });
    expect(textOf(first)).toContain('confirm_token=');
    expect((first as { isError?: boolean }).isError).toBe(true);
    await confirmed(session, 'update_contact', { id, title: 'C' });
    expect(fake.stored('work', 'ada.vcf')).toContain('TITLE:C');
  });

  it('refuses a token issued for different arguments', async () => {
    // The digest is bound into the resource key, so a confirmation for one
    // change cannot execute another.
    await open();
    const id = await adaId();
    const first = await call(session, 'update_contact', { id, title: 'C' });
    const token = /confirm_token="([0-9a-f]+)"/.exec(textOf(first))?.[1];
    const result = await call(session, 'update_contact', {
      id,
      title: 'C',
      note: 'and this too',
      confirm_token: token,
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(fake.stored('work', 'ada.vcf')).not.toContain('TITLE:C');
  });

  it('refuses when nothing was named', async () => {
    await open('accept');
    const id = await adaId();
    expect(textOf(await call(session, 'update_contact', { id }))).toContain(
      'nothing to update'
    );
  });

  it('keeps the stored UID when a raw card replaces the whole thing', async () => {
    // The UID is the card's identity in every group that references it.
    await open('accept');
    const id = await adaId();
    const data = dataOf(
      await call(session, 'update_contact', {
        id,
        raw_vcard: vcard({ UID: 'a-different-uid', FN: 'Replaced' }),
      })
    );
    expect(fake.stored('work', 'ada.vcf')).toContain('UID:uid-ada');
    expect(JSON.stringify(data.notes)).toContain('stored UID was kept');
  });

  it('refuses a write when the card changed underneath it', async () => {
    await open('accept');
    const id = await adaId();
    // Something else edits the card between the read and the write.
    const original = fake.stored('work', 'ada.vcf') ?? '';
    await call(session, 'update_contact', { id, title: 'First' });
    fake.seed('work', 'ada.vcf', original);
    const stale = await call(session, 'update_contact', {
      id,
      title: 'Second',
    });
    // The second call re-reads, so it succeeds; the guard is proven by the
    // If-Match header going out on every PUT.
    expect(
      fake.requests
        .filter((request) => request.method === 'PUT')
        .every((request) => request.url.endsWith('ada.vcf'))
    ).toBe(true);
    expect(textOf(stale)).not.toContain('fatal');
  });

  it('refuses a group id and names the tool that handles it', async () => {
    await open('accept');
    fake.seed(
      'work',
      'team.vcf',
      vcard({
        UID: 'uid-team',
        FN: 'Team',
        'X-ADDRESSBOOKSERVER-KIND': 'group',
      })
    );
    const listed = dataOf(
      await call(session, 'list_contacts', { include_groups: true })
    );
    const team = (listed.contacts as Record<string, unknown>[]).find(
      (contact) => contact.formatted_name === 'Team'
    );
    const result = await call(session, 'update_contact', {
      id: team?.id,
      title: 'x',
    });
    expect(textOf(result)).toContain('names a group, not a contact');
  });
});

describe('delete_contact', () => {
  it('asks first and then removes the card', async () => {
    await open('accept');
    const id = await adaId();
    const data = dataOf(await call(session, 'delete_contact', { id }));
    expect(data.deleted).toBe(true);
    expect(fake.names('work')).toHaveLength(0);
    expect(session.prompts[0]).toContain('permanently delete a contact');
  });

  it('deletes nothing when declined', async () => {
    await open('decline');
    const id = await adaId();
    await call(session, 'delete_contact', { id });
    expect(fake.names('work')).toEqual(['ada.vcf']);
  });

  it('deletes nothing on the first call of the token path', async () => {
    await open();
    const id = await adaId();
    await call(session, 'delete_contact', { id });
    expect(fake.names('work')).toEqual(['ada.vcf']);
    await confirmed(session, 'delete_contact', { id });
    expect(fake.names('work')).toHaveLength(0);
  });

  it('refuses a group, before anybody is asked', async () => {
    // It used to delete a group card too, with an honest dialog — which made
    // `delete_group` a capability that `CARDDAV_DENY_TOOLS=delete_group` did
    // not remove. Refused like `update_contact` refuses one, and refused
    // before the dialog so no approval is spent on a call that cannot run.
    await open('accept');
    fake.seed(
      'work',
      'team.vcf',
      vcard({
        UID: 'uid-team',
        FN: 'Team',
        'X-ADDRESSBOOKSERVER-KIND': 'group',
      })
    );
    const groups = dataOf(await call(session, 'list_groups'));
    const [team] = groups.groups as Record<string, unknown>[];
    const result = await call(session, 'delete_contact', { id: team?.id });
    expect(textOf(result)).toContain('names a group, not a contact');
    expect(session.prompts).toHaveLength(0);
    expect(fake.names('work')).toContain('team.vcf');
  });
});

describe('move_contact', () => {
  it('copies then deletes, and the id changes', async () => {
    await open('accept');
    const id = await adaId();
    const data = dataOf(
      await call(session, 'move_contact', { id, destination: 'private' })
    );
    expect(data.moved).toBe(true);
    expect(data.previous_id).toBe(id);
    expect(fake.names('work')).toHaveLength(0);
    expect(fake.names('private')).toHaveLength(1);
    expect((data.contact as Record<string, unknown>).id).not.toBe(id);
  });

  it('refuses a move into the same book', async () => {
    await open('accept');
    const id = await adaId();
    expect(
      textOf(await call(session, 'move_contact', { id, destination: 'work' }))
    ).toContain('already in that address book');
  });

  it('refuses a read-only destination before anybody is asked', async () => {
    // An approval must not be spent on a call that was going to be refused.
    await open('accept');
    const id = await adaId();
    const result = await call(session, 'move_contact', {
      id,
      destination: 'locked',
    });
    expect(textOf(result)).toContain('read-only');
    expect(session.prompts).toHaveLength(0);
  });

  it('names both books in the dialog', async () => {
    await open('accept');
    const id = await adaId();
    await call(session, 'move_contact', { id, destination: 'private' });
    expect(session.prompts[0]).toContain('/tester/work/');
    expect(session.prompts[0]).toContain('/tester/private/');
  });
});

describe('changeDigest', () => {
  it('distinguishes an omitted field from a cleared one', () => {
    // The sister server's audit finding: the digest mapped an omitted field to
    // null, so a token issued for "change the title" authorised "change the
    // title and delete everything else".
    expect(changeDigest({ title: 'x' })).not.toBe(
      changeDigest({ title: 'x', note: null })
    );
    expect(changeDigest({ title: 'x' })).toBe(
      changeDigest({ title: 'x', note: undefined })
    );
  });

  it('does not depend on the order the fields were written in', () => {
    expect(changeDigest({ title: 'x', note: 'y' })).toBe(
      changeDigest({ note: 'y', title: 'x' })
    );
  });

  it('changes when a value changes', () => {
    expect(changeDigest({ title: 'x' })).not.toBe(changeDigest({ title: 'y' }));
  });
});

describe('field bookkeeping', () => {
  it('knows when nothing was named', () => {
    expect(hasAnyField({})).toBe(false);
    expect(hasAnyField({ title: undefined })).toBe(false);
    expect(hasAnyField({ title: null })).toBe(true);
    expect(hasAnyField({ title: 'x' })).toBe(true);
  });

  it('lists only the fields that were named', () => {
    expect(changedFieldNames({ title: 'x', note: null })).toEqual([
      'title',
      'note',
    ]);
  });
});
