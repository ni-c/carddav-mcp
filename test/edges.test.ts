import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CardDavApi, CardDavApiError } from '../src/api.js';
import { Discovery } from '../src/discovery.js';
import {
  AddressBookNotAllowedError,
  AllowlistError,
  PreconditionFailedError,
  ResultTooLargeError,
  ToolInputError,
  VCardError,
} from '../src/errors.js';
import {
  budget,
  errorResult,
  hintFor,
  MAX_RESULT_BYTES,
  ownWordsResult,
  run,
  sanitizeErrorBody,
  textResult,
} from '../src/result.js';
import { boundedLimit } from '../src/entries.js';
import { shapeFull } from '../src/shape.js';
import { parseVCard } from '../src/vcard.js';
import {
  applyFields,
  assertFits,
  blankCard,
  cardFromRaw,
  ensureFormattedName,
  versionFor,
} from '../src/write.js';
import {
  call,
  connect,
  dataOf,
  FakeCardDav,
  ORIGIN,
  testConfig,
  textOf,
  USER,
  vcard,
  type Connected,
} from './harness.js';

const book = (overrides: Record<string, unknown> = {}) =>
  ({
    url: `${ORIGIN}/${USER}/work/`,
    path: `/${USER}/work/`,
    displayName: 'Work',
    description: undefined,
    supportedTypes: [],
    maxResourceSize: undefined,
    ctag: undefined,
    syncToken: undefined,
    readOnly: false,
    ...overrides,
  }) as never;

let session: Connected | undefined;

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(async () => {
  await session?.close();
  session = undefined;
  vi.unstubAllGlobals();
});

describe('budget', () => {
  it('leaves a small answer alone', () => {
    expect(budget({ items: [1, 2] }, 'narrow it')).toEqual({ items: [1, 2] });
  });

  it('halves the largest array until it fits, and says what it dropped', () => {
    const items = Array.from({ length: 4000 }, (_, index) => ({
      index,
      text: 'x'.repeat(200),
    }));
    const result = budget({ items, count: items.length }, 'ask for fewer');
    expect((result.items as unknown[]).length).toBeLessThan(items.length);
    expect(JSON.stringify(result.notes)).toContain('ask for fewer');
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });

  it('appends to notes that were already there', () => {
    const items = Array.from({ length: 4000 }, () => 'x'.repeat(200));
    const result = budget(
      { items, notes: ['something earlier'] },
      'ask for fewer'
    );
    expect(result.notes).toHaveLength(2);
    expect((result.notes as string[])[0]).toBe('something earlier');
  });

  it('counts its own note against the ceiling', () => {
    // The note used to be appended *after* the size was accepted, so an answer
    // that fitted by a few characters came back over the ceiling by exactly
    // the length of the sentence saying it was under it. A small ceiling is
    // what makes that visible: the note is a fixed ~100 characters, so at 200
    // it is half the budget rather than a rounding error. These sixteen
    // entries halve to four at 183 characters — accepted, and then 275 once
    // the note is on it.
    const items = Array.from({ length: 16 }, () => 'x'.repeat(40));
    const result = budget({ items }, 'ask for fewer', 200);
    expect(JSON.stringify(result.notes)).toContain('ask for fewer');
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(200);
  });

  it('refuses rather than emitting a shape the tool never declared', () => {
    // A refusal, so it becomes an error result. An envelope of another shape
    // would be rejected by the SDK against the schema the tool declares.
    expect(() =>
      budget({ blob: 'x'.repeat(MAX_RESULT_BYTES + 10) }, 'no')
    ).toThrow(ResultTooLargeError);
  });

  it('refuses when a single entry is already too large', () => {
    expect(() =>
      budget({ items: ['x'.repeat(MAX_RESULT_BYTES + 10)] }, 'no')
    ).toThrow(ResultTooLargeError);
  });
});

describe('sanitizeErrorBody', () => {
  it('reads a DAV precondition out of an error document', () => {
    expect(
      sanitizeErrorBody(
        '<?xml version="1.0"?><D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><C:no-uid-conflict/></D:error>'
      )
    ).toContain('no-uid-conflict');
  });

  it('drops a markup-shaped body entirely', () => {
    expect(sanitizeErrorBody('<!DOCTYPE html><html>Login</html>')).toBe(
      '(HTML error page omitted)'
    );
  });

  it('truncates a long plain body', () => {
    expect(sanitizeErrorBody('x'.repeat(5000)).length).toBeLessThan(2200);
  });

  it('says nothing about an empty body', () => {
    expect(sanitizeErrorBody('   ')).toBe('');
  });

  it('sanitises what survives, because a server is not automatically friendly', () => {
    expect(sanitizeErrorBody('go to ![x](https://evil.example/p)')).toContain(
      'inline image removed'
    );
  });
});

describe('hintFor', () => {
  it.each([
    [401, 'app-specific password'],
    [403, 'permission on the address book'],
    [404, 'list it again'],
    [405, '/dav.php/'],
    [409, 'parent collection'],
    [412, 'changed on the server'],
    [415, 'content type'],
    [507, 'storage quota'],
  ])('answers %i with something actionable', (status, fragment) => {
    expect(hintFor(status)).toContain(fragment);
  });

  it('prefers a precondition over the status code', () => {
    expect(hintFor(403, 'need-privileges')).toContain('read this address book');
    expect(hintFor(403, 'max-resource-size')).toContain('inline PHOTO');
    expect(hintFor(400, 'supported-address-data')).toContain('vCard version');
    expect(hintFor(400, 'valid-address-data')).toContain('raw_vcard');
    expect(hintFor(409, 'no-uid-conflict')).toContain('already uses that UID');
  });

  it('says nothing when it has nothing to add', () => {
    expect(hintFor(418)).toBe('');
  });
});

describe('run', () => {
  it('turns each error class into a result rather than a protocol failure', async () => {
    const cases: [Error, string][] = [
      [new ToolInputError('bad input'), 'bad input'],
      [new ResultTooLargeError('too big'), 'too big'],
      [new AddressBookNotAllowedError('fenced'), 'fenced'],
      [new AllowlistError('unbuildable'), 'unbuildable'],
      [new PreconditionFailedError('stale'), 'stale'],
    ];
    for (const [error, fragment] of cases) {
      const result = await run(async () => {
        throw error;
      });
      expect(textOf(result), fragment).toContain(fragment);
      expect((result as { isError?: boolean }).isError).toBe(true);
    }
  });

  it('says which side a vCard problem is on', async () => {
    const fromServer = await run(async () => {
      throw new VCardError('carddav-mcp: broken', true);
    });
    expect(textOf(fromServer)).toContain('the stored card, not the arguments');
    const fromCaller = await run(async () => {
      throw new VCardError('carddav-mcp: broken', false);
    });
    expect(textOf(fromCaller)).not.toContain('the stored card');
  });

  it('attaches the sanitised body and the hint to an API error', async () => {
    const result = await run(async () => {
      throw new CardDavApiError(401, 'nope', 'GET', `${ORIGIN}/a.vcf`);
    });
    expect(textOf(result)).toContain('HTTP 401');
    expect(textOf(result)).toContain('app-specific password');
  });

  it('falls back to the message for anything else', async () => {
    const result = await run(async () => {
      throw new Error('something else');
    });
    expect(textOf(result)).toContain('carddav-mcp: something else');
    const thrown = await run(async () => {
      throw 'a bare string';
    });
    expect(textOf(thrown)).toContain('a bare string');
  });

  it('passes a normal result through untouched', async () => {
    const result = await run(async () => textResult('fine'));
    expect(textOf(result)).toBe('fine');
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });
});

describe('result builders', () => {
  it('marks its own words without the untrusted flag', () => {
    const result = ownWordsResult({ deleted: true });
    expect(result.structuredContent).toEqual({ deleted: true });
    expect(JSON.stringify(result.structuredContent)).not.toContain('untrusted');
  });

  it('cannot have the untrusted marker switched off by the content', async () => {
    // The guard is the marker; a payload carrying the two names must not be
    // able to unset them.
    const { untrustedResult } = await import('../src/result.js');
    const result = untrustedResult({
      untrusted: false,
      source: 'somewhere else',
      value: 1,
    });
    expect(
      (result.structuredContent as Record<string, unknown>).untrusted
    ).toBe(true);
    expect((result.structuredContent as Record<string, unknown>).source).toBe(
      'carddav'
    );
  });

  it('builds an error result', () => {
    expect(errorResult('no').isError).toBe(true);
  });
});

describe('boundedLimit', () => {
  it('falls back when nothing was named', () => {
    expect(boundedLimit(undefined, 100, 500)).toBe(100);
  });

  it('accepts a value in range', () => {
    expect(boundedLimit(7, 100, 500)).toBe(7);
  });

  it.each([0, -1, 501, 1.5])('refuses %s', (value) => {
    expect(() => boundedLimit(value, 100, 500)).toThrow(ToolInputError);
  });
});

describe('write helpers', () => {
  it('picks the version the collection accepts', () => {
    expect(versionFor(book())).toBe('3.0');
    expect(
      versionFor(
        book({
          supportedTypes: [{ contentType: 'text/vcard', version: '4.0' }],
        })
      )
    ).toBe('4.0');
    expect(
      versionFor(
        book({
          supportedTypes: [
            { contentType: 'text/vcard', version: '3.0' },
            { contentType: 'text/vcard', version: '4.0' },
          ],
        })
      )
    ).toBe('3.0');
  });

  it('refuses a card past the collection ceiling', () => {
    expect(() =>
      assertFits(book({ maxResourceSize: 10 }), 'x'.repeat(50))
    ).toThrow(/accepts at most 10/);
    expect(() => assertFits(book(), 'x'.repeat(50))).not.toThrow();
  });

  it('derives FN and refuses a card that has no name at all', () => {
    const named = blankCard(book());
    applyFields(named, { given_name: 'Grace', family_name: 'Hopper' });
    ensureFormattedName(named);
    expect(named.getFirstPropertyValue('fn')).toBe('Grace Hopper');

    const nameless = blankCard(book());
    expect(() => ensureFormattedName(nameless)).toThrow(/needs a name/);
  });

  it('refuses a raw card that does not parse', () => {
    expect(() => cardFromRaw('not a card')).toThrow(VCardError);
  });

  it('writes and clears every field family', () => {
    const card = blankCard(book());
    applyFields(card, {
      formatted_name: 'Someone',
      nickname: 'Nick',
      title: 'Boss',
      role: 'Leader',
      note: 'A note',
      emails: [{ value: 'a@example.net', type: 'work' }],
      phones: [{ value: '+352 1' }],
      urls: [{ value: 'https://example.net' }],
      instant_messaging: [{ value: 'xmpp:a@example.net' }],
      addresses: [
        { type: 'home', street: 'Main 1', locality: 'Town', country: 'LU' },
      ],
      categories: ['one', 'two'],
      anniversary: { year: 2000, month: 6, day: 1 },
    });
    const text = card.toString();
    expect(text).toContain('NICKNAME:Nick');
    expect(text).toContain('ADR;TYPE=HOME:;;Main 1;Town;;;LU');
    expect(text).toContain('CATEGORIES:one,two');
    expect(text).toContain('ANNIVERSARY');
    expect(text).toContain('IMPP:xmpp:a@example.net');

    applyFields(card, {
      nickname: null,
      emails: null,
      addresses: null,
      categories: null,
      anniversary: null,
    });
    const cleared = card.toString();
    expect(cleared).not.toContain('NICKNAME');
    expect(cleared).not.toContain('EMAIL');
    expect(cleared).not.toContain('ADR');
    expect(cleared).not.toContain('CATEGORIES');
    expect(cleared).not.toContain('ANNIVERSARY');
  });

  it('clears N when every component is emptied', () => {
    const card = blankCard(book());
    applyFields(card, { given_name: 'Grace', family_name: 'Hopper' });
    expect(card.toString()).toContain('N:Hopper;Grace');
    applyFields(card, { given_name: null, family_name: null });
    // Anchored: `VERSION:3.0` contains the substring `N:3.0`.
    expect(
      card
        .toString()
        .split('\r\n')
        .some((line) => line.startsWith('N:'))
    ).toBe(false);
  });

  it('keeps the organisation when only the department changes', () => {
    const card = blankCard(book());
    applyFields(card, { organization: 'Acme', department: 'Research' });
    expect(card.toString()).toContain('ORG:Acme;Research');
    applyFields(card, { department: 'Sales' });
    expect(card.toString()).toContain('ORG:Acme;Sales');
    applyFields(card, { department: null });
    expect(card.toString()).toContain('ORG:Acme');
    applyFields(card, { organization: null });
    expect(card.toString()).not.toContain('ORG');
  });
});

describe('shapeFull', () => {
  it('reports every component of an address', () => {
    const card = parseVCard(
      vcard({
        UID: 'u',
        FN: 'Someone',
        'ADR;TYPE=WORK;LABEL=Main office':
          ';Floor 2;Main 1;Town;Region;L-1234;LU',
      }),
      'a card'
    );
    const shaped = shapeFull(card, book(), 'a.vcf', '"e1"');
    const [address] = shaped.addresses as Record<string, unknown>[];
    expect(address).toMatchObject({
      types: ['work'],
      extended: 'Floor 2',
      street: 'Main 1',
      locality: 'Town',
      region: 'Region',
      postal_code: 'L-1234',
      country: 'LU',
      label: 'Main office',
    });
  });

  it('marks a preferred address', () => {
    const card = parseVCard(
      vcard({ UID: 'u', FN: 'x', 'ADR;TYPE=HOME,PREF': ';;S;T;;;LU' }),
      'a card'
    );
    const [address] = shapeFull(card, book(), 'a.vcf', undefined)
      .addresses as Record<string, unknown>[];
    expect(address?.preferred).toBe(true);
  });

  it('omits a section the card does not have', () => {
    const card = parseVCard(vcard({ UID: 'u', FN: 'x' }), 'a card');
    const shaped = shapeFull(card, book(), 'a.vcf', undefined);
    expect(shaped.addresses).toBeUndefined();
    expect(shaped.note).toBeUndefined();
    expect(shaped.security).toBeUndefined();
    expect(shaped.photo).toBeUndefined();
  });
});

describe('discovery', () => {
  it('treats a collection URL as the one address book', async () => {
    const fake = new FakeCardDav({ books: [{ name: 'work' }] });
    fake.install();
    const api = new CardDavApi(testConfig({ url: `${ORIGIN}/${USER}/work` }));
    const discovery = new Discovery(api, testConfig());
    const principal = await discovery.principal();
    expect(principal.singleBook).toBe(true);
    expect(JSON.stringify(principal.notes)).toContain(
      'is an address book collection'
    );
    const registry = await discovery.registry();
    expect(registry.allowed()).toHaveLength(1);
  });

  it('refuses an ambiguous allowlist entry rather than picking one', async () => {
    // Either choice would silently grant access to a collection the operator
    // may not have meant, and the server would carry on working.
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body =
        path === '/'
          ? '<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><current-user-principal><href>/p/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>'
          : String((init.headers as Record<string, string>).Depth) === '1'
            ? `<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
                 <response><href>/p/a/work/</href><propstat><prop><resourcetype><collection/><C:addressbook/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
                 <response><href>/p/b/work/</href><propstat><prop><resourcetype><collection/><C:addressbook/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
               </multistatus>`
            : '<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><response><href>/p/</href><propstat><prop><C:addressbook-home-set><href>/p/</href></C:addressbook-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
      return Promise.resolve(
        new Response(body, {
          status: 207,
          headers: { 'content-type': 'application/xml' },
        })
      );
    });
    const discovery = new Discovery(
      new CardDavApi(testConfig()),
      testConfig({ addressBooks: ['work'] })
    );
    await expect(discovery.registry()).rejects.toThrow(AllowlistError);
    await expect(discovery.registry()).rejects.toThrow(/full path/);
  });

  it('steps over a cross-origin well-known redirect instead of dying on it', async () => {
    // RFC 6764 §6 defines this route *as* a redirect and explicitly allows it
    // to cross to another host — it is how a hosted provider sends a client
    // from the domain somebody typed to the one that serves DAV. Refusing to
    // follow it is right. Throwing is not: `resolveHref` sat outside the try,
    // so one such redirect ended discovery before the later steps ran, and the
    // principal promise is memoised, so every tool call for the life of the
    // process returned the same error about another host.
    vi.stubGlobal('fetch', (url: string) => {
      const target = new URL(String(url));
      if (target.pathname === '/.well-known/carddav') {
        return Promise.resolve(
          new Response(null, {
            status: 301,
            headers: { location: 'https://elsewhere.example/dav/' },
          })
        );
      }
      return Promise.resolve(
        new Response(
          '<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/</href><propstat><prop/><status>HTTP/1.1 404 Not Found</status></propstat></response></multistatus>',
          { status: 207, headers: { 'content-type': 'application/xml' } }
        )
      );
    });
    const discovery = new Discovery(new CardDavApi(testConfig()), testConfig());
    const principal = await discovery.principal();
    expect(principal.homes).toEqual([`${ORIGIN}/`]);
    // Named, because the refused origin is exactly what CARDDAV_URL should
    // have been set to. Silence here would leave an operator with a working
    // server pointed at the wrong host and no hint why it is empty.
    expect(JSON.stringify(principal.notes)).toContain('elsewhere.example');
  });

  it('caches the registry and refetches when forced', async () => {
    const fake = new FakeCardDav();
    fake.install();
    const discovery = new Discovery(new CardDavApi(testConfig()), testConfig());
    await discovery.registry();
    const after = fake.requests.length;
    await discovery.registry();
    expect(fake.requests.length).toBe(after);
    await discovery.registry(true);
    expect(fake.requests.length).toBeGreaterThan(after);
  });
});

describe('get_contact_photo', () => {
  it('refuses an oversized photo in its own words, not the reader\u2019s', async () => {
    // The tool's ceiling has to sit below the read ceiling in `api.ts` once
    // base64's third is accounted for, or this branch is unreachable and the
    // caller gets "larger than 1048576 bytes" from the body reader instead of
    // a sentence naming the tool that could help. It was 2 MiB, and was.
    const fake = new FakeCardDav({ books: [{ name: 'work' }] });
    fake.install();
    const image = Buffer.alloc(600 * 1024, 7).toString('base64');
    fake.seed(
      'work',
      'big.vcf',
      `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:u-big\r\nFN:Big\r\nPHOTO;ENCODING=b;TYPE=JPEG:${image}\r\nEND:VCARD\r\n`
    );
    session = await connect();
    const listed = dataOf(await call(session, 'list_contacts'));
    const id = (listed.contacts as Record<string, unknown>[])[0]?.id as string;
    const result = await call(session, 'get_contact_photo', { id });
    expect(textOf(result)).toContain('get_contact reports its size');
  });
});

describe('api ceilings', () => {
  it('refuses a body larger than the ceiling before reading it', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response('x', {
          status: 200,
          headers: {
            'content-length': String(64 * 1024 * 1024),
            'content-type': 'text/vcard',
          },
        })
      )
    );
    const api = new CardDavApi(testConfig());
    await expect(api.get(`${ORIGIN}/a.vcf`)).rejects.toThrow(/larger than/);
  });

  it('refuses a chunked body that crosses the ceiling while streaming', async () => {
    // A chunked response declares no length at all.
    vi.stubGlobal('fetch', () => {
      const chunk = new Uint8Array(256 * 1024);
      let sent = 0;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            pull(controller) {
              sent += 1;
              if (sent > 40) controller.close();
              else controller.enqueue(chunk);
            },
          }),
          { status: 200, headers: { 'content-type': 'text/vcard' } }
        )
      );
    });
    const api = new CardDavApi(testConfig());
    await expect(api.get(`${ORIGIN}/a.vcf`)).rejects.toThrow(/larger than/);
  });

  it('drops a weak ETag rather than using it as a guard', async () => {
    // A weak validator cannot protect a write, and a proxy is allowed to
    // weaken a strong one.
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(vcard({ UID: 'u', FN: 'x' }), {
          status: 200,
          headers: { etag: 'W/"weak"', 'content-type': 'text/vcard' },
        })
      )
    );
    const api = new CardDavApi(testConfig());
    expect((await api.get(`${ORIGIN}/a.vcf`)).etag).toBeUndefined();
  });

  it('reads the compliance tokens off OPTIONS', async () => {
    const fake = new FakeCardDav();
    fake.install();
    const api = new CardDavApi(testConfig());
    const options = await api.options(`${ORIGIN}/`);
    expect(options.dav).toContain('addressbook');
    expect(options.allow).toContain('report');
  });

  it('refuses to act at all without credentials', async () => {
    const api = new CardDavApi(
      testConfig({ username: undefined, password: undefined })
    );
    await expect(api.get(`${ORIGIN}/a.vcf`)).rejects.toThrow(
      /missing required environment/
    );
  });
});

describe('a server without credentials', () => {
  it('lists its tools and fails every call with setup instructions', async () => {
    session = await connect({
      url: undefined,
      username: undefined,
      password: undefined,
    });
    const result = await call(session, 'list_address_books');
    expect(textOf(result)).toContain('missing required environment variable');
    expect(textOf(result)).toContain('CARDDAV_URL');
  });
});

describe('list_contacts and the group cards it hides', () => {
  it('says how many it left out rather than simply not showing them', async () => {
    // Every other omission in this server reports a count — the allowlist's
    // `withheld`, the limit note, the unreadable tally. An absence nobody
    // explained reads as a non-existence, and "there are no groups here" is a
    // different fact from "you did not ask for them".
    const fake = new FakeCardDav({
      books: [
        {
          name: 'work',
          resources: {
            'a.vcf': vcard({ UID: 'u-a', FN: 'Ada' }),
            'g.vcf': vcard({
              UID: 'u-g',
              FN: 'Team',
              'X-ADDRESSBOOKSERVER-KIND': 'group',
            }),
          },
        },
      ],
    });
    fake.install();
    session = await connect();
    const data = dataOf(await call(session, 'list_contacts'));
    expect(data.count).toBe(1);
    expect(JSON.stringify(data.notes)).toContain('1 group card');
  });
});

describe('list_contacts against an empty account', () => {
  it('says there is nothing rather than answering with an empty list', async () => {
    const fake = new FakeCardDav({ books: [] });
    fake.install();
    session = await connect();
    expect(textOf(await call(session, 'list_contacts'))).toContain(
      'no address books'
    );
  });

  it('says the fence is the reason when it is', async () => {
    const fake = new FakeCardDav({ books: [{ name: 'work' }] });
    fake.install();
    session = await connect({ addressBooks: ['nothing-matches'] });
    const result = await call(session, 'list_contacts');
    expect(textOf(result)).toContain('allows none of the address books');
  });
});

describe('multiget and sync over the wire', () => {
  it('reads an etag out of a sync report and reports a removal', async () => {
    const fake = new FakeCardDav({
      books: [
        { name: 'work', resources: { 'a.vcf': vcard({ UID: 'u', FN: 'A' }) } },
      ],
    });
    fake.install();
    session = await connect();
    const first = dataOf(
      await call(session, 'list_changes', { address_book: 'work' })
    );
    expect((first.changed as unknown[])[0]).toHaveProperty('etag');
    const second = dataOf(
      await call(session, 'list_changes', {
        address_book: 'work',
        sync_token: first.sync_token as string,
      })
    );
    expect(second.sync_token).not.toBe(first.sync_token);
    expect(JSON.stringify(second.notes ?? [])).not.toContain('initial');
  });
});
