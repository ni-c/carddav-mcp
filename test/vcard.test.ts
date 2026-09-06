import { describe, expect, it } from 'vitest';

import { VCardError } from '../src/errors.js';
import {
  formatDate,
  groupModelOf,
  isGroup,
  isPreferred,
  markAsGroup,
  memberUid,
  membersOf,
  newVCard,
  parseVCard,
  photoBytes,
  photoInfo,
  readDate,
  readList,
  readStructured,
  readText,
  readTyped,
  resourceNameFor,
  serializeVCard,
  setMembers,
  touch,
  typesOf,
  versionOf,
  writeStructured,
  writeText,
  writeTyped,
} from '../src/vcard.js';

const CRLF = '\r\n';
const card = (lines: string[]): string => `${lines.join(CRLF)}${CRLF}`;

describe('parseVCard', () => {
  it('reads a plain vCard 3.0 card', () => {
    const parsed = parseVCard(
      card([
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Ada Lovelace',
        'N:Lovelace;Ada;;;',
        'END:VCARD',
      ]),
      'a card'
    );
    expect(versionOf(parsed)).toBe('3.0');
    expect(readText(parsed, 'fn')).toBe('Ada Lovelace');
  });

  it('hoists VERSION so the design set matches the grammar it parsed with', () => {
    // The load-bearing one. ical.js picks vCard 3 or vCard 4 from whether
    // property zero is VERSION, and the parser and the hydrated Property
    // objects disagree about the fallback — so a card whose VERSION sits
    // second parses under one grammar and reads back under the other. The
    // symptom is not an error: EMAIL simply comes back undefined, and a
    // contact quietly loses every address it had.
    const parsed = parseVCard(
      card([
        'BEGIN:VCARD',
        'FN:Ada Lovelace',
        'VERSION:3.0',
        'EMAIL;TYPE=WORK:ada@example.net',
        'END:VCARD',
      ]),
      'a card'
    );
    expect(versionOf(parsed)).toBe('3.0');
    expect(readTyped(parsed, 'email')).toEqual([
      { value: 'ada@example.net', types: ['work'], preferred: false },
    ]);
  });

  it('refuses something that is not a vCard', () => {
    expect(() => parseVCard('not a card at all', 'a card')).toThrow(VCardError);
    expect(() =>
      parseVCard(
        card(['BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR']),
        'a card'
      )
    ).toThrow(/not a VCARD/);
  });

  it('marks a parse failure as coming from the server', () => {
    try {
      parseVCard('BEGIN:VCARD\r\nnonsense\r\n', 'the stored card');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(VCardError);
      expect((error as VCardError).fromServer).toBe(true);
    }
  });

  it('does not paste the offending line into the message', () => {
    const hostile = 'A'.repeat(5000);
    try {
      parseVCard(`BEGIN:VCARD\r\n${hostile}\r\n`, 'the stored card');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(400);
    }
  });
});

describe('typed values', () => {
  const parsed = parseVCard(
    card([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Multi',
      'TEL;TYPE=WORK,VOICE,PREF:+44 20 7946 0101',
      'TEL;TYPE=cell:+44 20 7946 0102',
      'TEL:+44 20 7946 0103',
      'END:VCARD',
    ]),
    'a card'
  );

  it('normalises TYPE whether it is a string or a list', () => {
    const phones = readTyped(parsed, 'tel');
    expect(phones.map((phone) => phone.types)).toEqual([
      ['work', 'voice', 'pref'],
      ['cell'],
      [],
    ]);
  });

  it('reads PREF from either spelling', () => {
    const [first, second] = parsed.getAllProperties('tel');
    expect(isPreferred(first!)).toBe(true);
    expect(isPreferred(second!)).toBe(false);
  });

  it('lowercases the type, because clients disagree about the case', () => {
    const upper = parseVCard(
      card([
        'BEGIN:VCARD',
        'VERSION:3.0',
        'EMAIL;TYPE=HOME:a@b.example',
        'END:VCARD',
      ]),
      'a card'
    );
    expect(typesOf(upper.getFirstProperty('email')!)).toEqual(['home']);
  });
});

describe('structured values', () => {
  it('splits N into five components, padding what is missing', () => {
    const parsed = parseVCard(
      card([
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:x',
        'N:Lovelace;Ada',
        'END:VCARD',
      ]),
      'a card'
    );
    expect(readStructured(parsed, 'n', 5)).toEqual([
      'Lovelace',
      'Ada',
      '',
      '',
      '',
    ]);
  });

  it('flattens a component that itself repeats', () => {
    const parsed = parseVCard(
      card([
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:x',
        'ADR:;;Street 1,Street 2;Town;;;LU',
        'END:VCARD',
      ]),
      'a card'
    );
    expect(readStructured(parsed, 'adr', 7)[2]).toBe('Street 1, Street 2');
  });

  it('round-trips through writeStructured', () => {
    const built = newVCard('u1', '3.0');
    writeStructured(built, 'n', ['Hopper', 'Grace', '', '', '']);
    const reparsed = parseVCard(serializeVCard(built), 'a card');
    expect(readStructured(reparsed, 'n', 5).slice(0, 2)).toEqual([
      'Hopper',
      'Grace',
    ]);
  });
});

describe('dates', () => {
  it('keeps a complete date', () => {
    const parsed = parseVCard(
      card([
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:x',
        'BDAY;VALUE=date:1815-12-10',
        'END:VCARD',
      ]),
      'a card'
    );
    expect(readDate(parsed, 'bday')).toEqual({
      year: 1815,
      month: 12,
      day: 10,
      raw: '1815-12-10',
    });
  });

  it('keeps a birthday whose year is unknown, without inventing one', () => {
    // A large share of the real birthdays in any address book look like this:
    // a phone writes it when the year was never entered. Mapping it to null
    // throws away a fact the card states.
    const parsed = parseVCard(
      card(['BEGIN:VCARD', 'VERSION:4.0', 'FN:x', 'BDAY:--1209', 'END:VCARD']),
      'a card'
    );
    const bday = readDate(parsed, 'bday');
    expect(bday?.year).toBeUndefined();
    expect(bday?.month).toBe(12);
    expect(bday?.day).toBe(9);
  });

  it('returns undefined when the card has none', () => {
    const parsed = parseVCard(
      card(['BEGIN:VCARD', 'VERSION:3.0', 'FN:x', 'END:VCARD']),
      'a card'
    );
    expect(readDate(parsed, 'bday')).toBeUndefined();
  });

  it('formats a complete date per version', () => {
    expect(formatDate({ year: 1815, month: 12, day: 10 }, '3.0')).toEqual({
      value: '1815-12-10',
      substitutedYear: false,
    });
    expect(formatDate({ year: 1815, month: 12, day: 10 }, '4.0')).toEqual({
      value: '18151210',
      substitutedYear: false,
    });
  });

  it('writes a yearless date natively in 4.0 and with the placeholder in 3.0', () => {
    expect(formatDate({ month: 4, day: 15 }, '4.0')).toEqual({
      value: '--0415',
      substitutedYear: false,
    });
    // RFC 2426 has no syntax for a date without a year, so 3.0 gets the
    // placeholder clients settled on — reported, so nobody reads it as a fact.
    expect(formatDate({ month: 4, day: 15 }, '3.0')).toEqual({
      value: '1604-04-15',
      substitutedYear: true,
    });
  });

  it('refuses a date with no month or day', () => {
    expect(() => formatDate({ year: 1815 }, '3.0')).toThrow(/month and a day/);
  });
});

describe('photos', () => {
  it('reports an inline 3.0 photo without decoding it into the answer', () => {
    const parsed = parseVCard(
      card([
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:x',
        'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg==',
        'END:VCARD',
      ]),
      'a card'
    );
    expect(photoInfo(parsed)).toEqual({
      storage: 'inline',
      mediaType: 'image/jpeg',
      bytes: 10,
      uri: undefined,
    });
  });

  it('reports a data: URI photo', () => {
    const parsed = parseVCard(
      card([
        'BEGIN:VCARD',
        'VERSION:4.0',
        'FN:x',
        'PHOTO:data:image/png;base64,iVBORw0KGgo=',
        'END:VCARD',
      ]),
      'a card'
    );
    const info = photoInfo(parsed);
    expect(info?.storage).toBe('inline');
    expect(info?.mediaType).toBe('image/png');
  });

  it('reports a linked photo as a URI and never fetches it', () => {
    const parsed = parseVCard(
      card([
        'BEGIN:VCARD',
        'VERSION:4.0',
        'FN:x',
        'PHOTO;MEDIATYPE=image/jpeg:https://elsewhere.example/p.jpg',
        'END:VCARD',
      ]),
      'a card'
    );
    expect(photoInfo(parsed)).toEqual({
      storage: 'uri',
      mediaType: 'image/jpeg',
      bytes: undefined,
      uri: 'https://elsewhere.example/p.jpg',
    });
    // The bytes path refuses it rather than reaching for the network.
    expect(photoBytes(parsed)).toBeUndefined();
  });

  it('decodes an inline photo when asked by name', () => {
    const parsed = parseVCard(
      card([
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:x',
        'PHOTO;ENCODING=b;TYPE=PNG:aGVsbG8=',
        'END:VCARD',
      ]),
      'a card'
    );
    const photo = photoBytes(parsed);
    expect(photo?.mediaType).toBe('image/png');
    expect(photo?.data.toString('utf8')).toBe('hello');
  });

  it('has no photo when the card has none', () => {
    const parsed = parseVCard(
      card(['BEGIN:VCARD', 'VERSION:3.0', 'FN:x', 'END:VCARD']),
      'a card'
    );
    expect(photoInfo(parsed)).toBeUndefined();
    expect(photoBytes(parsed)).toBeUndefined();
  });
});

describe('groups', () => {
  const apple = parseVCard(
    card([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Team',
      'X-ADDRESSBOOKSERVER-KIND:group',
      'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:aaaa',
      'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:bbbb',
      'END:VCARD',
    ]),
    'a card'
  );
  const rfc = parseVCard(
    card([
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:Team',
      'KIND:group',
      'MEMBER:urn:uuid:cccc',
      'MEMBER:mailto:x@example.net',
      'END:VCARD',
    ]),
    'a card'
  );

  it('reads both conventions', () => {
    expect(groupModelOf(apple)).toBe('apple');
    expect(groupModelOf(rfc)).toBe('rfc');
    expect(isGroup(apple) && isGroup(rfc)).toBe(true);
  });

  it('reads the membership of each', () => {
    expect(membersOf(apple)).toEqual(['urn:uuid:aaaa', 'urn:uuid:bbbb']);
    expect(membersOf(rfc)).toEqual(['urn:uuid:cccc', 'mailto:x@example.net']);
  });

  it('extracts a UID only from a urn:uuid reference', () => {
    expect(memberUid('urn:uuid:abc')).toBe('abc');
    expect(memberUid('mailto:x@example.net')).toBeUndefined();
  });

  it('treats a card with members but no KIND as a group', () => {
    // Some clients omit the marker. Trusting the members rather than the
    // marker is what stops such a group being listed as an ordinary contact.
    const implied = parseVCard(
      card([
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Team',
        'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:aaaa',
        'END:VCARD',
      ]),
      'a card'
    );
    expect(groupModelOf(implied)).toBe('apple');
  });

  it('is not a group when it is an ordinary card', () => {
    const contact = parseVCard(
      card(['BEGIN:VCARD', 'VERSION:3.0', 'FN:Ada', 'END:VCARD']),
      'a card'
    );
    expect(isGroup(contact)).toBe(false);
    expect(membersOf(contact)).toEqual([]);
  });

  it('clears both conventions when writing membership', () => {
    // A card carrying members in both conventions must not come out of an edit
    // with one set updated and the other stale — that reads as a group whose
    // membership depends on which client is asking.
    const mixed = parseVCard(
      card([
        'BEGIN:VCARD',
        'VERSION:4.0',
        'FN:Team',
        'KIND:group',
        'MEMBER:urn:uuid:old',
        'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:older',
        'END:VCARD',
      ]),
      'a card'
    );
    setMembers(mixed, 'rfc', ['new']);
    expect(membersOf(mixed)).toEqual(['urn:uuid:new']);
    expect(mixed.getAllProperties('x-addressbookserver-member')).toHaveLength(
      0
    );
  });

  it('marks a card as a group in one convention only', () => {
    const built = newVCard('u1', '3.0');
    markAsGroup(built, 'apple');
    expect(built.getFirstPropertyValue('x-addressbookserver-kind')).toBe(
      'group'
    );
    expect(built.getFirstPropertyValue('kind')).toBeNull();
    markAsGroup(built, 'rfc');
    expect(built.getFirstPropertyValue('kind')).toBe('group');
    expect(built.getFirstPropertyValue('x-addressbookserver-kind')).toBeNull();
  });

  it('keeps a member reference that already has a scheme', () => {
    const built = newVCard('u1', '4.0');
    setMembers(built, 'rfc', ['mailto:x@example.net', 'plain-uid']);
    expect(membersOf(built)).toEqual([
      'mailto:x@example.net',
      'urn:uuid:plain-uid',
    ]);
  });
});

describe('building a card', () => {
  it('puts VERSION first, which is what ical.js reads the grammar from', () => {
    const built = newVCard('u1', '3.0');
    writeText(built, 'fn', 'Ada Lovelace');
    const lines = serializeVCard(built).split(CRLF);
    expect(lines[0]).toBe('BEGIN:VCARD');
    expect(lines[1]).toBe('VERSION:3.0');
  });

  it('folds a caller CR so it cannot start a content line nobody wrote', () => {
    const built = newVCard('u1', '3.0');
    writeText(built, 'note', 'first\r\nsecond\rthird');
    const serialised = serializeVCard(built);
    // ical.js escapes LF; a raw CR would end the line for a lenient reader.
    expect(serialised).not.toMatch(/\rt/);
    expect(serialised).toContain('\\n');
  });

  it('removes a property when the value is null and leaves it when undefined', () => {
    const built = newVCard('u1', '3.0');
    writeText(built, 'nickname', 'Countess');
    writeText(built, 'nickname', undefined);
    expect(readText(built, 'nickname')).toBe('Countess');
    writeText(built, 'nickname', null);
    expect(readText(built, 'nickname')).toBeUndefined();
  });

  it('replaces every occurrence of a typed property', () => {
    const built = newVCard('u1', '3.0');
    writeTyped(built, 'email', [
      { value: 'a@example.net', type: 'work' },
      { value: 'b@example.net' },
    ]);
    writeTyped(built, 'email', [{ value: 'c@example.net', type: 'home' }]);
    expect(readTyped(built, 'email')).toEqual([
      { value: 'c@example.net', types: ['home'], preferred: false },
    ]);
  });

  it('writes the TYPE in upper case, which 3.0 clients expect', () => {
    const built = newVCard('u1', '3.0');
    writeTyped(built, 'tel', [{ value: '+44 20 7946 0101', type: 'cell' }]);
    expect(serializeVCard(built)).toContain('TEL;TYPE=CELL:');
  });

  it('stamps a REV that survives serialisation on both versions', () => {
    // The trap runs in both directions and neither raises an error. On a 3.0
    // card ical.js takes the basic form and writes out a timestamp one digit
    // short — silently corrupt, on the server, noticed by nobody. On a 4.0
    // card it takes the extended form, writes it out correctly, and then
    // throws when the same value is read back. So the spelling is chosen per
    // version, and what is asserted here is the *serialised* result.
    for (const version of ['3.0', '4.0'] as const) {
      const built = newVCard('u1', version);
      touch(built);
      const rev = serializeVCard(built)
        .split(CRLF)
        .find((line) => line.startsWith('REV:'));
      expect(rev, version).toMatch(/^REV:\d{8}T\d{6}Z$/);
      expect(() => readText(built, 'rev'), version).not.toThrow();
    }
  });

  it('would corrupt a 3.0 REV given the basic form — which is why it is not', () => {
    // Pinning the library behaviour the branch above exists for. If ical.js
    // ever fixes this, this test fails and the branch can go.
    const built = newVCard('u1', '3.0');
    built.updatePropertyWithValue('rev', '20260905T230516Z');
    const rev = serializeVCard(built)
      .split(CRLF)
      .find((line) => line.startsWith('REV:'));
    expect(rev).toBe('REV:20260905T23016Z');
  });

  it('derives a resource name from a uid', () => {
    expect(resourceNameFor('abc-123')).toBe('abc-123.vcf');
  });
});

describe('surviving a value ical.js cannot decorate', () => {
  it('reads REV back off a 4.0 card this process just built', () => {
    // ical.js types REV as a `timestamp` on a vCard 4.0 card and *serialises*
    // the basic format correctly — which is the only spelling 4.0 accepts —
    // but reading the same value back off the in-memory object routes through
    // the iCalendar date-time parser and throws. `create_contact` against a
    // 4.0 address book hit exactly this: the write succeeded and shaping the
    // answer blew up.
    const built = newVCard('u1', '4.0');
    touch(built);
    expect(() => readText(built, 'rev')).not.toThrow();
    expect(readText(built, 'rev')).toMatch(/^\d{8}T\d{6}Z$/);
    // And the round trip agrees, which is the tell that the value was fine and
    // the decoration was not.
    const reparsed = parseVCard(serializeVCard(built), 'a card');
    expect(readText(reparsed, 'rev')).toBeDefined();
  });

  it('reads a malformed date as the text the card holds', () => {
    // A card written years ago by some client. An exception here does not lose
    // one field, it takes get_contact down for the whole card.
    const parsed = parseVCard(
      card([
        'BEGIN:VCARD',
        'VERSION:4.0',
        'FN:x',
        'BDAY:not-a-date',
        'END:VCARD',
      ]),
      'a card'
    );
    expect(() => readDate(parsed, 'bday')).not.toThrow();
    expect(readDate(parsed, 'bday')).toEqual({ raw: 'not-a-date' });
  });
});

describe('readList', () => {
  it('collects every occurrence and drops the empty ones', () => {
    const parsed = parseVCard(
      card([
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:x',
        'CATEGORIES:one',
        'CATEGORIES:two',
        'END:VCARD',
      ]),
      'a card'
    );
    expect(readList(parsed, 'categories')).toEqual(['one', 'two']);
  });
});
