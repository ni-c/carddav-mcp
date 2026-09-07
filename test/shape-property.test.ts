import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AddressBookEntry } from '../src/books.js';
import {
  fullContact,
  shapedContact,
  shapedGroup,
} from '../src/output-schema.js';
import { shapeFull, shapeGroup, shapeSummary } from '../src/shape.js';
import { isGroup, parseVCard } from '../src/vcard.js';
import { ORIGIN, vcard } from './harness.js';

/**
 * The shape layer against arbitrary property values.
 *
 * Every field a listing or a `get_contact` reports is derived from text
 * somebody else wrote into a card, and the output schema is validated by the
 * SDK before the answer leaves: a shape that does not fit the schema is not a
 * wrong field, it is a failed call. The examples in the other files cover the
 * values that were tried; this states the contract over every value the
 * generator can spell — for any card that parses, shaping does not throw and
 * the result validates, for both vCard versions and for every property this
 * server reads.
 *
 * A generated value that breaks the card's own grammar (a line break inside a
 * value, say) makes a card that does not parse, and a card that does not parse
 * is somebody else's contract; those runs pass vacuously.
 */

const RUNS = { numRuns: 300 };

const book: AddressBookEntry = {
  url: `${ORIGIN}/tester/contacts/`,
  path: '/tester/contacts/',
  displayName: undefined,
  description: undefined,
  supportedTypes: [],
  maxResourceSize: undefined,
  ctag: undefined,
  syncToken: undefined,
  readOnly: false,
};

/** Any text at all, in either alphabet the generator knows. */
const anyText = fc.oneof(
  fc.string({ maxLength: 120, unit: 'grapheme' }),
  fc.string({ maxLength: 120, unit: 'binary' }),
  fc.constantFrom(
    '',
    ';;;',
    ',',
    '\\,',
    '\\;',
    'a\\nb',
    'constructor',
    '__proto__',
    'urn:uuid:',
    'urn:uuid:abc',
    'mailto:x@y',
    'https://u:p@h/',
    '1e308',
    '99999999999999999999',
    '-0',
    'NaN',
    '20240230',
    '--0229',
    '2024-02-30T25:61:61Z',
    '1;2;3;4;5;6;7',
    'geo:1,2',
    '+01:00',
    'javascript:alert(1)'
  )
);

/** The properties this server reads, keyed the way the `vcard()` helper wants. */
const PROPERTY_NAMES = [
  'FN',
  'N',
  'NICKNAME',
  'ORG',
  'TITLE',
  'ROLE',
  'ADR',
  'TEL',
  'TEL;TYPE=cell',
  'EMAIL',
  'EMAIL;TYPE=work',
  'URL',
  'IMPP',
  'BDAY',
  'BDAY;VALUE=date',
  'ANNIVERSARY',
  'REV',
  'GEO',
  'TZ',
  'PHOTO',
  'PHOTO;ENCODING=b;TYPE=jpeg',
  'PHOTO;VALUE=uri',
  'CATEGORIES',
  'NOTE',
  'KIND',
  'MEMBER',
  'X-ADDRESSBOOKSERVER-KIND',
  'X-ADDRESSBOOKSERVER-MEMBER',
  'UID',
  'PRODID',
  'X-CUSTOM',
] as const;

const fields = fc
  .uniqueArray(fc.tuple(fc.constantFrom(...PROPERTY_NAMES), anyText), {
    minLength: 1,
    maxLength: 8,
    selector: ([name]) => name,
  })
  .map((entries) => Object.fromEntries(entries));

const version = fc.constantFrom('3.0', '4.0');

function shapesValidly(cardText: string): void {
  let card;
  try {
    card = parseVCard(cardText, 'a generated card');
  } catch {
    return;
  }
  const summary = shapeSummary(card, book, 'x.vcf', '"1"', true);
  expect(shapedContact.safeParse(summary).success).toBe(true);
  const full = shapeFull(card, book, 'x.vcf', '"1"');
  expect(fullContact.safeParse(full).success).toBe(true);
  if (isGroup(card)) {
    const group = shapeGroup(card, book, 'x.vcf', '"1"', () => undefined);
    expect(shapedGroup.safeParse(group).success).toBe(true);
  }
  // Nothing a shape returns may carry a raw control character; that is the
  // sanitizer's promise, and the schema alone would not notice.
  const serialised = JSON.stringify({ summary, full });
  expect(
    [...serialised].some((c) => {
      const code = c.codePointAt(0) ?? 0;
      return (
        (code < 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) ||
        code === 0x7f
      );
    })
  ).toBe(false);
}

describe('the shape layer over arbitrary property values', () => {
  it('shapes every card that parses into something the schema accepts', () => {
    fc.assert(
      fc.property(fields, version, (props, v) => {
        shapesValidly(vcard(props, v));
      }),
      RUNS
    );
  });

  it('holds when a value is repeated across several lines of one property', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('TEL', 'EMAIL', 'URL', 'ADR', 'CATEGORIES', 'MEMBER'),
        fc.array(anyText, { minLength: 2, maxLength: 5 }),
        version,
        (name, values, v) => {
          const lines = ['BEGIN:VCARD', `VERSION:${v}`, 'FN:x'];
          if (name === 'MEMBER') lines.push('KIND:group');
          for (const value of values) lines.push(`${name}:${value}`);
          lines.push('END:VCARD');
          shapesValidly(`${lines.join('\r\n')}\r\n`);
        }
      ),
      RUNS
    );
  });
});
