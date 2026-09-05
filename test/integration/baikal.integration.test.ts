import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type LiveHarness } from 'mcp-integration-harness';

import {
  bootstrapBaikal,
  getRawBaikal,
  putRawBaikal,
  type BaikalSandbox,
} from './baikal.js';
import { FORBIDDEN_BOOK, vcard } from './bootstrap.js';

/**
 * The portability pass: sabre/dav, not Radicale.
 *
 * Deliberately **not** a second copy of the coverage suite, and deliberately
 * without `expectEveryToolExercised`. That question — does every tool work at
 * all — is answered once, against Radicale. What this file asks is narrower and
 * is the reason a second backend exists: do the places where two correct
 * CardDAV servers legitimately differ still work?
 *
 * Each block below is one such place.
 */

let sandbox: BaikalSandbox;
let server: LiveHarness;

function data(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

beforeAll(async () => {
  sandbox = await bootstrapBaikal();
  server = await startServer({ env: sandbox.env, elicit: 'accept' });
}, 600_000);

afterAll(async () => {
  await server?.close();
});

describe('discovery under a path prefix', () => {
  it('walks from /dav.php to the address books', async () => {
    // Baikal serves DAV from a path rather than from the origin, so every href
    // is prefixed and `CARDDAV_URL` keeps its path. A server that stripped the
    // path would send discovery to a root that answers 404.
    const answer = data(await server.call('list_address_books'));
    expect(answer.count).toBe(2);
    const ids = (answer.address_books as Record<string, unknown>[]).map(
      (book) => String(book.id)
    );
    for (const id of ids) expect(id.startsWith('/dav.php/')).toBe(true);
    expect(ids).not.toContain(
      `/dav.php/addressbooks/integration/${FORBIDDEN_BOOK}/`
    );
  });
});

describe('sabre’s lowercase prefixes', () => {
  it('reads a multistatus written with d: and card: rather than a default namespace', async () => {
    // The one difference the unit suite can simulate. Asserted here anyway,
    // because "the fake agrees with us" and "sabre agrees with us" are
    // different statements.
    await putRawBaikal(
      sandbox,
      'work',
      'ada.vcf',
      vcard({
        UID: 'uid-ada',
        FN: 'Ada Lovelace',
        'EMAIL;TYPE=WORK': 'ada@example.net',
        NOTE: 'Tom & Jerry',
      })
    );
    const answer = data(await server.call('list_contacts'));
    expect(answer.count).toBe(1);
    const [contact] = answer.contacts as Record<string, unknown>[];
    expect(contact?.formatted_name).toBe('Ada Lovelace');
  });

  it('entity-decodes address-data, including the card’s own line endings', async () => {
    // Two decodes in one assertion, and the second is the one this backend
    // found: without `&amp;` a contact called `Tom & Jerry` reaches the model
    // as `Tom &amp; Jerry`, and without `&#13;` every card sabre returns is
    // `BEGIN:VCARD&#13;` and does not parse at all.
    const listed = data(await server.call('list_contacts'));
    const [contact] = listed.contacts as Record<string, unknown>[];
    const text = await server.call('get_contact', { id: contact?.id });
    expect(text).toContain('Tom & Jerry');
    expect(text).not.toContain('Tom &amp; Jerry');
  });
});

describe('supported-address-data', () => {
  it('reports both versions sabre accepts, where Radicale names only 3.0', async () => {
    const answer = data(await server.call('list_address_books'));
    const [book] = answer.address_books as Record<string, unknown>[];
    expect(book?.supported_versions).toEqual(['3.0', '4.0']);
  });
});

describe('writing against sabre', () => {
  it('creates a card sabre accepts and stores as written', async () => {
    const answer = data(
      await server.call('create_contact', {
        address_book: 'private',
        given_name: 'Grace',
        family_name: 'Hopper',
        emails: [{ value: 'grace@example.net', type: 'work' }],
        birthday: { month: 12, day: 9 },
      })
    );
    expect(answer.created).toBe(true);
    const id = (answer.contact as Record<string, unknown>).id as string;
    const name = `${id.split('.')[2] ?? ''}`;
    expect(name).toBeTruthy();
  });

  it('guards a change with an ETag sabre issued', async () => {
    // sabre issues strong ETags; a weak one would make the write tools refuse
    // rather than race, which is the behaviour under test everywhere else.
    const listed = data(
      await server.call('list_contacts', { address_books: ['private'] })
    );
    const [contact] = listed.contacts as Record<string, unknown>[];
    expect(contact?.etag).toBeTruthy();
    await server.call('update_contact', {
      id: contact?.id,
      title: 'Rear Admiral',
    });
    const again = data(await server.call('get_contact', { id: contact?.id }));
    expect((again.contact as Record<string, unknown>).title).toBe(
      'Rear Admiral'
    );
  });
});

describe('search across two implementations', () => {
  it('matches several fields in one request here too', async () => {
    // RFC 6352 gives `<C:filter>` a `test` attribute defaulting to anyof. A
    // server that read it as an intersection would answer "no matches" rather
    // than erroring, so this is worth asserting on both backends.
    const answer = data(
      await server.call('search_contacts', { query: 'hopper' })
    );
    expect(answer.count).toBe(1);
  });

  it('says which path it took', async () => {
    const answer = data(
      await server.call('search_contacts', { query: 'lovelace' })
    );
    expect(['server-filter', 'client-filter']).toContain(answer.matched_with);
  });
});

describe('groups on sabre', () => {
  it('round-trips a group through create, read and delete', async () => {
    const listed = data(
      await server.call('list_contacts', { address_books: ['work'] })
    );
    const [member] = listed.contacts as Record<string, unknown>[];
    const created = data(
      await server.call('create_group', {
        address_book: 'work',
        name: 'Sabre Group',
        members: [member?.id],
      })
    );
    const groupId = (created.group as Record<string, unknown>).id as string;

    const read = data(await server.call('get_group', { id: groupId }));
    expect((read.group as Record<string, unknown>).member_count).toBe(1);
    expect(read.unresolved).toBe(0);

    await server.call('delete_group', { id: groupId });
    expect(data(await server.call('list_groups')).count).toBe(0);
  });
});

describe('sync-collection on sabre', () => {
  it('hands back a token and reports a later change against it', async () => {
    const first = data(
      await server.call('list_changes', { address_book: 'work' })
    );
    expect(first.sync_token).toBeTruthy();
    await putRawBaikal(
      sandbox,
      'work',
      'newcomer.vcf',
      vcard({ UID: 'uid-newcomer', FN: 'Newcomer' })
    );
    const second = data(
      await server.call('list_changes', {
        address_book: 'work',
        sync_token: first.sync_token as string,
      })
    );
    expect((second.changed as unknown[]).length).toBeGreaterThanOrEqual(1);
  });
});

describe('deleting against sabre', () => {
  it('removes the card and the server agrees it is gone', async () => {
    const listed = data(
      await server.call('list_contacts', { address_books: ['private'] })
    );
    const [contact] = listed.contacts as Record<string, unknown>[];
    const name = Buffer.from(
      String(contact?.id).split('.')[2] ?? '',
      'base64url'
    ).toString();
    await server.call('delete_contact', { id: contact?.id });
    const { status } = await getRawBaikal(sandbox, 'private', name);
    expect(status).toBe(404);
  });
});
