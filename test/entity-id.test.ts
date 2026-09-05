import { describe, expect, it } from 'vitest';

import { AddressBookRegistry, resourceUrl } from '../src/books.js';
import { buildEntityId, parseEntityId } from '../src/entity-id.js';
import { AddressBookNotAllowedError, ToolInputError } from '../src/errors.js';

const book = (name: string, readOnly = false) => ({
  url: `https://dav.example.net/tester/${name}/`,
  path: `/tester/${name}/`,
  displayName: name,
  description: undefined,
  supportedTypes: [],
  maxResourceSize: undefined,
  ctag: undefined,
  syncToken: undefined,
  readOnly,
});

const all = [book('work'), book('private'), book('shared')];
const fenced = new AddressBookRegistry(all, ['work', 'private']);
const open = new AddressBookRegistry(all, []);

describe('buildEntityId', () => {
  it('round-trips a path and a name', () => {
    const id = buildEntityId('/tester/work/', 'ada.vcf');
    const parsed = parseEntityId(id, open);
    expect(parsed).toEqual({
      bookPath: '/tester/work/',
      resourceName: 'ada.vcf',
    });
  });

  it('carries no origin, so a forged id can only name a local path', () => {
    const id = buildEntityId('/tester/work/', 'ada.vcf');
    expect(id).not.toContain('dav.example.net');
    expect(Buffer.from(id.split('.')[1] ?? '', 'base64url').toString()).toBe(
      '/tester/work/'
    );
  });

  it('survives a name that needs percent-encoding', () => {
    const id = buildEntityId('/tester/work/', 'a%20b.vcf');
    expect(parseEntityId(id, open).resourceName).toBe('a%20b.vcf');
  });
});

describe('parseEntityId', () => {
  it('refuses anything that is not three parts', () => {
    for (const id of ['c1', 'c1.abc', 'c1.a.b.c', '']) {
      expect(() => parseEntityId(id, open), id).toThrow(ToolInputError);
    }
  });

  it('refuses an unknown tag', () => {
    const good = buildEntityId('/tester/work/', 'a.vcf');
    const bad = `x9.${good.split('.').slice(1).join('.')}`;
    expect(() => parseEntityId(bad, open)).toThrow(/not an id this server/);
  });

  it('refuses base64 that is not exactly base64url of UTF-8', () => {
    // `Buffer.from(…, 'base64url')` is lenient — it ignores characters outside
    // the alphabet and accepts a truncated group, so two different strings can
    // decode to the same value. These strings are compared against an
    // allowlist, so the mapping has to be one-to-one.
    const good = buildEntityId('/tester/work/', 'a.vcf');
    const [tag, path, name] = good.split('.');
    expect(() => parseEntityId(`${tag}.${path}=.${name}`, open)).toThrow();
    expect(() => parseEntityId(`${tag}.${path}.${name}!`, open)).toThrow();
  });

  it('refuses a NUL in a decoded part', () => {
    const id = `c1.${Buffer.from('/tester/work/\0', 'utf8').toString('base64url')}.${Buffer.from('a.vcf').toString('base64url')}`;
    expect(() => parseEntityId(id, open)).toThrow(ToolInputError);
  });

  it('refuses a relative or dot-segmented book path', () => {
    for (const path of [
      'tester/work/',
      '/tester/../work/',
      '/tester/./work/',
    ]) {
      const id = `c1.${Buffer.from(path).toString('base64url')}.${Buffer.from('a.vcf').toString('base64url')}`;
      expect(() => parseEntityId(id, open), path).toThrow(ToolInputError);
    }
  });

  it.each([
    ['a slash', 'sub/a.vcf'],
    ['a backslash', '..\\a.vcf'],
    ['a leading dot', '.hidden'],
    ['a percent-encoded dot segment', '%2E%2E'],
    ['a question mark', 'a?x=1'],
    ['a fragment', 'a#f'],
    ['an empty name', ''],
  ])('refuses a resource name with %s', (_label, name) => {
    const id = `c1.${Buffer.from('/tester/work/').toString('base64url')}.${Buffer.from(name).toString('base64url')}`;
    expect(() => parseEntityId(id, open)).toThrow(ToolInputError);
  });

  it('enforces the allowlist while decoding, not afterwards', () => {
    // The structural property: there is no path from an id to a URL that does
    // not pass through here, so "the allowlist is checked per tool" cannot be
    // forgotten by a tool.
    const id = buildEntityId('/tester/shared/', 'a.vcf');
    expect(() => parseEntityId(id, fenced)).toThrow(AddressBookNotAllowedError);
    expect(() => parseEntityId(id, fenced)).toThrow(/was not given access to/);
  });

  it('says something different for a book that does not exist at all', () => {
    // "Fenced off" and "not there" are different situations, and telling them
    // apart is what stops somebody hunting a typo that is not there.
    const id = buildEntityId('/tester/nowhere/', 'a.vcf');
    expect(() => parseEntityId(id, fenced)).toThrow(/cannot see/);
  });
});

describe('resourceUrl', () => {
  const target = book('work');

  it('joins a collection and a name', () => {
    expect(resourceUrl(target, 'ada.vcf')).toBe(
      'https://dav.example.net/tester/work/ada.vcf'
    );
  });

  it.each([
    ['a percent-encoded dot segment', '%2E%2E'],
    ['a backslash walk', '..\\x.vcf'],
    ['a query string', 'a?x=1'],
    ['a fragment', 'a#f'],
    ['the collection itself', ''],
  ])('refuses %s on the resolved path', (_label, name) => {
    // Checking the *name* is not the same as checking the *path*: the WHATWG
    // URL parser normalises a percent-encoded dot segment and treats a
    // backslash as a separator, long after any string check has passed.
    expect(() => resourceUrl(target, name)).toThrow(ToolInputError);
  });

  it('refuses a name that would not round-trip', () => {
    // Requiring the resolved pathname to equal the collection plus the name
    // exactly means the name has to already be canonical — which is precisely
    // the form `resourceNameOf` hands out.
    expect(() => resourceUrl(target, 'a b.vcf')).toThrow(ToolInputError);
  });
});

describe('AddressBookRegistry', () => {
  it('matches by full URL, absolute path and final segment', () => {
    expect(open.resolve('https://dav.example.net/tester/work/').path).toBe(
      '/tester/work/'
    );
    expect(open.resolve('/tester/work').path).toBe('/tester/work/');
    expect(open.resolve('work').path).toBe('/tester/work/');
  });

  it('does not match on a display name', () => {
    // A display name is chosen by whoever shared the book, is not unique and
    // changes. An allowlist keyed on one is not an allowlist.
    const named = new AddressBookRegistry(
      [{ ...book('abc'), displayName: 'Work' }],
      ['Work']
    );
    expect(named.allowed()).toHaveLength(0);
  });

  it('reports what the fence withheld rather than hiding it', () => {
    expect(fenced.allowed().map((entry) => entry.path)).toEqual([
      '/tester/work/',
      '/tester/private/',
    ]);
    expect(fenced.withheld()).toBe(1);
  });

  it('refuses a fenced-off book differently from an unknown one', () => {
    expect(() => fenced.resolve('shared')).toThrow(AddressBookNotAllowedError);
    expect(() => fenced.resolve('nowhere')).toThrow(/no address book called/);
  });

  it('returns the permitted books when asked for none', () => {
    expect(fenced.resolveMany()).toHaveLength(2);
    expect(fenced.resolveMany([])).toHaveLength(2);
  });

  it('de-duplicates two spellings of one book', () => {
    expect(fenced.resolveMany(['work', '/tester/work/'])).toHaveLength(1);
  });

  it('names an allowlist entry that matched nothing', () => {
    const typo = new AddressBookRegistry(all, ['work', 'wrok']);
    expect(typo.unmatched()).toEqual(['wrok']);
  });

  it('reports an ambiguous final segment rather than picking one', () => {
    const twins = new AddressBookRegistry(
      [
        { ...book('work'), path: '/a/work/', url: 'https://h/a/work/' },
        { ...book('work'), path: '/b/work/', url: 'https://h/b/work/' },
      ],
      ['work']
    );
    expect(twins.ambiguous()).toEqual([
      { entry: 'work', paths: ['/a/work/', '/b/work/'] },
    ]);
  });

  it('accepts 3.0 when the server declared nothing', () => {
    // RFC 6352 §6.2.2: an absent supported-address-data means text/vcard 3.0,
    // not "nothing is accepted". Radicale advertises none at all.
    const silent = book('work');
    expect(open.accepts(silent, '3.0')).toBe(true);
    expect(open.accepts(silent, '4.0')).toBe(false);
  });

  it('honours a declared version set', () => {
    const modern = {
      ...book('work'),
      supportedTypes: [{ contentType: 'text/vcard', version: '4.0' }],
    };
    expect(open.accepts(modern, '4.0')).toBe(true);
    expect(open.accepts(modern, '3.0')).toBe(false);
  });
});
