import { z } from 'zod';

import { hasControlCharacters } from './analyze.js';
import { MAX_MAX_ENTRIES } from './config.js';

/**
 * Input schemas more than one tool uses.
 *
 * A shape only one tool takes belongs next to that tool. What lives here is the
 * vocabulary — an id, an address book reference, the contact fields — so that
 * `create_contact` and `update_contact` cannot drift into describing the same
 * field two ways.
 *
 * **Control characters are refused rather than stripped.** A `NOTE` containing
 * a bare CR would end one vCard content line and start another, so a value
 * carrying one is not a value with a cosmetic problem — it is an attempt to
 * write a property nobody asked for, or a paste accident that corrupts the card
 * either way. The character class lives in `analyze.ts` and is shared with the
 * read path, because two copies of it would be two definitions of the same
 * word.
 */

/** Multi-line text a caller may put into a card: a note, a label. */
export const cardText = z
  .string()
  .max(8192)
  .refine(
    (value) => !hasControlCharacters(value, { allowNewlines: true }),
    'must not contain control characters'
  );

/** A single-line field: a name, an organisation, a job title, an address. */
export const shortText = z
  .string()
  .max(512)
  .refine(
    (value) => !hasControlCharacters(value),
    'must be a single line without control characters'
  );

/** An id issued by one of the listing tools. */
export const entityId = z
  .string()
  .min(1)
  .max(2048)
  .describe(
    'An id from list_contacts, search_contacts, list_groups or list_changes.'
  );

/** An address book, named the way `list_address_books` prints it. */
export const addressBookRef = z
  .string()
  .min(1)
  .max(2048)
  .describe(
    'An address book id from list_address_books — its collection path. A ' +
      'full URL or the final path segment work too.'
  );

/** Several address books; absent means every one this server may see. */
export const addressBooksParam = z
  .array(addressBookRef)
  .max(64)
  .optional()
  .describe(
    'Which address books to look in. Leave it out for every address book ' +
      'this server may see.'
  );

/** How many entries a listing returns. */
export const limitParam = z
  .number()
  .int()
  .min(1)
  .max(MAX_MAX_ENTRIES)
  .optional()
  .describe(
    'How many entries to return. Defaults to CARDDAV_MAX_CONTACTS, at most ' +
      `${MAX_MAX_ENTRIES}.`
  );

/** The confirmation token a guarded tool hands back on its first call. */
export const confirmTokenParam = z
  .string()
  .max(256)
  .optional()
  .describe(
    'Only for a client that cannot show a dialog: the token from this tool’s ' +
      'own previous refusal, quoted back to confirm.'
  );

/** One typed value on the way in — an email address, a phone number, a URL. */
export const typedInput = z.object({
  value: shortText,
  type: shortText
    .optional()
    .describe(
      'TYPE parameter, e.g. work, home, cell. Written in upper case, which ' +
        'is what vCard 3.0 clients expect.'
    ),
});

/** A postal address on the way in. */
export const addressInput = z.object({
  type: shortText.optional(),
  po_box: shortText.optional(),
  extended: shortText.optional(),
  street: shortText.optional(),
  locality: shortText.optional().describe('City.'),
  region: shortText.optional().describe('State or province.'),
  postal_code: shortText.optional(),
  country: shortText.optional(),
});

/**
 * A date on the way in, with the year optional.
 *
 * The year is optional because a large share of real birthdays do not have one
 * — a phone writes `BDAY:--0415` when the year was never entered, and a schema
 * that demanded a year would force the caller to invent one. See `formatDate`
 * in `vcard.ts` for what a yearless date becomes in each vCard version.
 */
export const dateInput = z
  .object({
    year: z.number().int().min(1).max(9999).optional(),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
  })
  // `month ≤ 12` and `day ≤ 31` checked apart let `BDAY:20260231` through.
  // Without a year the 29th of February is allowed: the year is unknown, and
  // it may well have been a leap year.
  .refine(
    ({ year, month, day }) => day <= daysInMonth(month, year),
    'is not a date that exists'
  );

function daysInMonth(month: number, year: number | undefined): number {
  if (month === 2) {
    if (year === undefined) return 29;
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * A whole vCard, for the cases the structured fields do not cover.
 *
 * The escape hatch, and it is deliberately narrow: it is refused unless it
 * parses, and on `update_contact` it replaces the card outright rather than
 * merging — a raw card is the caller saying they know what the whole thing
 * should be. The size cap is well under the read ceiling in `api.ts`, because a
 * card a caller typed is not a card carrying a photograph.
 */
export const rawVCard = z
  .string()
  .min(1)
  .max(256 * 1024)
  // Line breaks are structure in a vCard and stay; everything else in the
  // control range — NUL, ESC, the C1 block — was the one exception to the
  // rule at the top of this file, and went out in a PUT verbatim.
  .refine(
    (value) => !hasControlCharacters(value, { allowNewlines: true }),
    'must not contain control characters other than line breaks'
  )
  .describe(
    'A complete vCard, for properties the named fields do not cover. On ' +
      'update this replaces the whole card rather than merging into it.'
  );

/** vCard properties `search_contacts` will match against. */
export const searchField = z.enum([
  'FN',
  'N',
  'NICKNAME',
  'EMAIL',
  'TEL',
  'ORG',
  'TITLE',
  'NOTE',
  'CATEGORIES',
  'UID',
]);
