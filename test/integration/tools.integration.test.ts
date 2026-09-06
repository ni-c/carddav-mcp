import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  expectEveryToolDeclaresOutputSchema,
  expectEveryToolExercised,
  startServer,
  toolCoverage,
  type LiveHarness,
} from 'mcp-integration-harness';

import { ALL_TOOLS } from '../../src/tools/catalogue.js';
import {
  bootstrapRadicale,
  FORBIDDEN_BOOK,
  getRaw,
  listRaw,
  putRaw,
  vcard,
  type Sandbox,
} from './bootstrap.js';

/**
 * Every tool, once, against a real Radicale.
 *
 * A sequential story rather than a table per tool: a real backend needs order
 * and shared state, so this creates, reads, changes and deletes in the order a
 * person would, and the coverage assertion comes last.
 *
 * Two servers run against the same sandbox. `asking` declares elicitation, so a
 * guarded tool raises the real dialog; `plain` declares none, so the same tools
 * fall back to the two-call token. Both paths are worth a run, and coverage is
 * the union of the two.
 */

let sandbox: Sandbox;
/** Declares elicitation, so guarded tools go through the real dialog. */
let asking: LiveHarness;
/** Declares none, so the same tools fall back to the two-call token. */
let plain: LiveHarness;

/** Reads the structured half of a result. */
function data(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

beforeAll(async () => {
  sandbox = await bootstrapRadicale();
  asking = await startServer({ env: sandbox.env, elicit: 'accept' });
  plain = await startServer({ env: sandbox.env });
}, 600_000);

afterAll(async () => {
  await asking?.close();
  await plain?.close();
});

describe('the connection', () => {
  it('lists the address books the allowlist permits', async () => {
    const answer = data(await asking.call('list_address_books'));
    expect(answer.count).toBe(2);
    expect(answer.withheld).toBe(1);
    const ids = (answer.address_books as Record<string, unknown>[]).map(
      (book) => book.id
    );
    expect(ids).not.toContain(`/integration/${FORBIDDEN_BOOK}/`);
  });

  it('reports what this Radicale can do', async () => {
    const answer = data(await asking.call('get_server_info'));
    expect(answer.dav_compliance).toContain('addressbook');
    // Probed rather than inferred: a server can advertise `addressbook` and
    // still refuse a filtered query.
    expect((answer.features as Record<string, boolean>).addressbook_query).toBe(
      true
    );
  });

  it('reports the vCard versions Radicale accepts', async () => {
    // Radicale 3.8 declares `text/vcard; version=3.0` and nothing else, so a
    // 4.0 write would be refused here — which is why `versionFor` follows what
    // the collection says rather than always writing the family default.
    const answer = data(await asking.call('list_address_books'));
    const [book] = answer.address_books as Record<string, unknown>[];
    expect(book?.supported_versions).toEqual(['3.0']);
  });
});

describe('contacts', () => {
  let adaId = '';

  it('starts from an empty address book', async () => {
    const answer = data(await asking.call('list_contacts'));
    expect(answer.count).toBe(0);
  });

  it('creates a contact', async () => {
    const answer = data(
      await asking.call('create_contact', {
        address_book: 'work',
        given_name: 'Ada',
        family_name: 'Lovelace',
        organization: 'Analytical Engines',
        department: 'Research',
        title: 'Mathematician',
        emails: [{ value: 'ada@example.net', type: 'work' }],
        phones: [{ value: '+44 20 7946 0111', type: 'cell' }],
        addresses: [
          { type: 'home', street: 'Main 1', locality: 'Town', country: 'GB' },
        ],
        birthday: { year: 1815, month: 12, day: 10 },
        categories: ['history', 'maths'],
        note: 'First programmer.',
      })
    );
    expect(answer.created).toBe(true);
    adaId = (answer.contact as Record<string, unknown>).id as string;
    expect(adaId).toBeTruthy();
  });

  it('stored a card a real client would read', async () => {
    // Read back off the server, not through this server's own shaping: an
    // assertion that goes through the projection only proves the server agrees
    // with itself.
    const [name] = await listRaw(sandbox, 'work');
    const { vcf } = await getRaw(sandbox, 'work', name ?? '');
    expect(vcf).toContain('VERSION:3.0');
    expect(vcf).toContain('FN:Ada Lovelace');
    expect(vcf).toContain('N:Lovelace;Ada;;;');
    expect(vcf).toContain('ORG:Analytical Engines;Research');
    expect(vcf).toContain('EMAIL;TYPE=WORK:ada@example.net');
    expect(vcf).toContain('ADR;TYPE=HOME:;;Main 1;Town;;;GB');
    expect(vcf).toContain('CATEGORIES:history,maths');
    expect(vcf).toContain('BDAY');
    // VERSION first, which is what ical.js reads the grammar from.
    expect(vcf.split('\r\n')[1]).toBe('VERSION:3.0');
  });

  it('lists it as a summary', async () => {
    const answer = data(await asking.call('list_contacts'));
    expect(answer.count).toBe(1);
    const [contact] = answer.contacts as Record<string, unknown>[];
    expect(contact?.formatted_name).toBe('Ada Lovelace');
    expect(contact?.organization).toBe('Analytical Engines');
    // A listing retrieves only the summary properties.
    expect(contact?.partial).toBe(true);
    expect(contact?.note).toBeUndefined();
  });

  it('reads the whole card, including what the listing left out', async () => {
    const text = await asking.call('get_contact', { id: adaId });
    expect(text).toContain('BEGIN UNTRUSTED CONTACT CONTENT');
    const answer = data(text.slice(text.indexOf('{')));
    const contact = answer.contact as Record<string, unknown>;
    expect(contact.note).toBe('First programmer.');
    expect(contact.birthday).toMatchObject({ year: 1815, month: 12, day: 10 });
    expect((contact.addresses as unknown[]).length).toBe(1);
  });

  it('finds it by name, organisation and email in one request each', async () => {
    for (const query of ['lovelace', 'Analytical', 'ada@example.net']) {
      const answer = data(await asking.call('search_contacts', { query }));
      expect(answer.count, query).toBe(1);
      expect(answer.matched_with, query).toBe('server-filter');
    }
  });

  it('changes a field and keeps everything else', async () => {
    await asking.call('update_contact', { id: adaId, title: 'Countess' });
    const [name] = await listRaw(sandbox, 'work');
    const { vcf } = await getRaw(sandbox, 'work', name ?? '');
    expect(vcf).toContain('TITLE:Countess');
    // Untouched by the edit.
    expect(vcf).toContain('NOTE:First programmer.');
    expect(vcf).toContain('CATEGORIES:history,maths');
  });

  it('exports the raw card in structuredContent and a defused rendering as text', async () => {
    // The one tool whose two channels differ on purpose: the structured half
    // is the byte-exact export, the text block is fenced and defused.
    const result = await asking.raw('export_contacts', {
      address_book: 'work',
    });
    const answer = result.structuredContent as Record<string, unknown>;
    expect(answer.count).toBe(1);
    const [entry] = answer.vcards as { vcard: string }[];
    expect(entry?.vcard).toContain('BEGIN:VCARD');
    const text = (result.content as { type: string; text?: string }[])
      .map((block) => block.text ?? '')
      .join('\n');
    expect(text).toContain('byte-exact export is in structuredContent');
    expect(text).toContain('BEGIN UNTRUSTED CONTACT CONTENT');
  });

  it('reports a photo without delivering it, then delivers it when asked', async () => {
    await putRaw(
      sandbox,
      'work',
      'pictured.vcf',
      vcard({
        UID: 'uid-pictured',
        FN: 'Pictured Person',
        // A real PNG signature followed by "hello": the media type on the
        // image block is decided by these bytes, never by `TYPE=PNG`.
        'PHOTO;ENCODING=b;TYPE=PNG': 'iVBORw0KGgpoZWxsbw==',
      })
    );
    const listed = data(await asking.call('list_contacts'));
    const pictured = (listed.contacts as Record<string, unknown>[]).find(
      (contact) => contact.formatted_name === 'Pictured Person'
    );
    expect(pictured).toBeDefined();
    expect(
      (pictured?.photo as Record<string, unknown> | undefined)?.storage
    ).toBe('inline');

    const raw = await asking.raw('get_contact_photo', { id: pictured?.id });
    const image = raw.content?.find((part) => part.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(
      Buffer.from(image?.data ?? '', 'base64')
        .subarray(8)
        .toString()
    ).toBe('hello');
  });

  it('reports what changed since a sync token', async () => {
    const first = data(
      await asking.call('list_changes', { address_book: 'work' })
    );
    expect(first.sync_token).toBeTruthy();
    await putRaw(
      sandbox,
      'work',
      'later.vcf',
      vcard({ UID: 'uid-later', FN: 'Later Person' })
    );
    const second = data(
      await asking.call('list_changes', {
        address_book: 'work',
        sync_token: first.sync_token as string,
      })
    );
    const changed = second.changed as { id: string }[];
    expect(changed.length).toBeGreaterThanOrEqual(1);
  });

  it('moves a contact to another address book', async () => {
    const answer = data(
      await asking.call('move_contact', { id: adaId, destination: 'private' })
    );
    expect(answer.moved).toBe(true);
    adaId = (answer.contact as Record<string, unknown>).id as string;
    expect(await listRaw(sandbox, 'private')).toHaveLength(1);
  });

  it('refuses to touch the address book the allowlist withholds', async () => {
    // The fence, against a real server rather than a fake.
    await asking.call(
      'list_contacts',
      { address_books: [FORBIDDEN_BOOK] },
      { expectError: /was not given access to/ }
    );
    await asking.call(
      'create_contact',
      { address_book: FORBIDDEN_BOOK, formatted_name: 'Nope' },
      { expectError: /was not given access to/ }
    );
  });

  it('deletes a contact through the two-call token', async () => {
    // The other half of the guard: this harness declares no elicitation.
    const before = await listRaw(sandbox, 'private');
    await plain.confirmed('delete_contact', { id: adaId });
    expect(await listRaw(sandbox, 'private')).toHaveLength(before.length - 1);
  });
});

describe('groups', () => {
  let groupId = '';
  let memberId = '';

  it('creates a group with a member', async () => {
    const listed = data(await asking.call('list_contacts'));
    const member = (listed.contacts as Record<string, unknown>[])[0];
    memberId = member?.id as string;

    const answer = data(
      await asking.call('create_group', {
        address_book: 'work',
        name: 'Pioneers',
        members: [memberId],
      })
    );
    expect(answer.created).toBe(true);
    groupId = (answer.group as Record<string, unknown>).id as string;
  });

  it('wrote the Apple convention, which is what a 3.0 book gets', async () => {
    const names = await listRaw(sandbox, 'work');
    const cards = await Promise.all(
      names.map(async (name) => (await getRaw(sandbox, 'work', name)).vcf)
    );
    const group = cards.find((vcf) => vcf.includes('FN:Pioneers'));
    expect(group).toContain('X-ADDRESSBOOKSERVER-KIND:group');
    expect(group).toContain('X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:');
  });

  it('lists the group without resolving its members', async () => {
    const answer = data(await asking.call('list_groups'));
    expect(answer.count).toBe(1);
    const [group] = answer.groups as Record<string, unknown>[];
    expect(group?.name).toBe('Pioneers');
    expect(group?.member_count).toBe(1);
  });

  it('resolves the members when asked for one group', async () => {
    const answer = data(await asking.call('get_group', { id: groupId }));
    expect(answer.unresolved).toBe(0);
    const members = (answer.group as Record<string, unknown>).members as Record<
      string,
      unknown
    >[];
    expect(members[0]?.formatted_name).toBeTruthy();
  });

  it('renames the group and empties it', async () => {
    const answer = data(
      await asking.call('update_group', {
        id: groupId,
        name: 'Renamed',
        remove_members: [memberId],
      })
    );
    expect(answer.removed).toBe(1);
    // The contact itself survives — only the grouping went.
    const listed = data(await asking.call('list_contacts'));
    expect(
      (listed.contacts as Record<string, unknown>[]).some(
        (contact) => contact.id === memberId
      )
    ).toBe(true);
  });

  it('deletes the group', async () => {
    const answer = data(await asking.call('delete_group', { id: groupId }));
    expect(answer.deleted).toBe(true);
    expect(data(await asking.call('list_groups')).count).toBe(0);
  });
});

describe('coverage', () => {
  it('declares an output schema on every tool', async () => {
    // The unit suite checks the same thing against a stub. Here it is checked
    // against the server that has just answered every one of these tools
    // against a real Radicale — and each of those answers went through the
    // SDK's validation against the schema below it.
    const { tools } = await asking.client.listTools();
    expectEveryToolDeclaresOutputSchema(tools);
  });

  it('exercises every tool in the catalogue', () => {
    // Both harnesses talk to the same instance, so coverage is their union.
    const called = new Set([...asking.called, ...plain.called]);
    const report = toolCoverage({ called }, ALL_TOOLS, {});
    console.log(
      `carddav-mcp: ${report.called.length}/${ALL_TOOLS.length} tools against a real Radicale` +
        (report.missing.length > 0
          ? `, missing: ${report.missing.join(', ')}`
          : '')
    );
    expectEveryToolExercised({ called }, ALL_TOOLS, {});
  });

  it('proves the two harnesses really took different paths', () => {
    // Without this, one of them quietly doing both would keep every token test
    // green.
    expect(asking.prompts.length).toBeGreaterThan(0);
    expect(plain.prompts).toHaveLength(0);
  });
});
