import { createHash } from 'node:crypto';

import { setResourceKey } from 'mcp-approval';

import type { CardDavApi } from './api.js';
import { resourceUrl, type AddressBookEntry } from './books.js';
import { PreconditionFailedError, ToolInputError } from './errors.js';
import {
  DEFAULT_VERSION,
  foldNewlines,
  formatDate,
  ICAL,
  isGroup,
  newUid,
  newVCard,
  parseVCard,
  readStructured,
  readText,
  resourceNameFor,
  serializeVCard,
  touch,
  versionOf,
  writeMultiValue,
  writeStructured,
  writeText,
  writeTyped,
  type TypedInput,
  type VCardVersion,
} from './vcard.js';

export type { TypedInput };

/**
 * Building and storing a card.
 *
 * Two rules run through this file, and both were bought by an audit round on
 * the sister server rather than reasoned out in advance.
 *
 * **A write reads first, and never rebuilds.** `update_contact` fetches the
 * whole card, changes the named properties and puts the same document back, so
 * an X-property some phone wrote in 2014 and a `PHOTO` nobody mentioned survive
 * an edit. Rebuilding from the structured fields would be simpler and would
 * silently delete everything the schema does not model.
 *
 * **An omitted field and a cleared field are different instructions.**
 * `undefined` means "leave it alone" and `null` means "remove it". Collapsing
 * the two is not a cosmetic bug: on the sister server the approval digest
 * mapped an omitted field to `null`, so a token issued for "change the title"
 * authorised "change the title and delete everything else". {@link changeDigest}
 * therefore hashes only the keys that are actually present.
 */

/** One postal address on the way in. */
export interface AddressInput {
  type?: string | undefined;
  po_box?: string | undefined;
  extended?: string | undefined;
  street?: string | undefined;
  locality?: string | undefined;
  region?: string | undefined;
  postal_code?: string | undefined;
  country?: string | undefined;
}

/** A date on the way in. `year` is optional; see `schema.ts`. */
export interface DateInput {
  year?: number | undefined;
  month: number;
  day: number;
}

/**
 * The fields a caller may set.
 *
 * `undefined` leaves a field alone; `null` removes it. Every optional property
 * spells `| undefined` because `exactOptionalPropertyTypes` is on, and a
 * handler that passes an explicitly-undefined value has to be indistinguishable
 * from one that passes nothing.
 */
export interface ContactFields {
  formatted_name?: string | null | undefined;
  given_name?: string | null | undefined;
  family_name?: string | null | undefined;
  additional_names?: string | null | undefined;
  name_prefix?: string | null | undefined;
  name_suffix?: string | null | undefined;
  nickname?: string | null | undefined;
  organization?: string | null | undefined;
  department?: string | null | undefined;
  title?: string | null | undefined;
  role?: string | null | undefined;
  emails?: TypedInput[] | null | undefined;
  phones?: TypedInput[] | null | undefined;
  urls?: TypedInput[] | null | undefined;
  instant_messaging?: TypedInput[] | null | undefined;
  addresses?: AddressInput[] | null | undefined;
  birthday?: DateInput | null | undefined;
  anniversary?: DateInput | null | undefined;
  note?: string | null | undefined;
  categories?: string[] | null | undefined;
}

/** Every key of {@link ContactFields}, for the digest and the emptiness check. */
export const CONTACT_FIELD_KEYS: readonly (keyof ContactFields)[] = [
  'formatted_name',
  'given_name',
  'family_name',
  'additional_names',
  'name_prefix',
  'name_suffix',
  'nickname',
  'organization',
  'department',
  'title',
  'role',
  'emails',
  'phones',
  'urls',
  'instant_messaging',
  'addresses',
  'birthday',
  'anniversary',
  'note',
  'categories',
];

/** Whether the caller named any field at all. */
export function hasAnyField(fields: ContactFields): boolean {
  return CONTACT_FIELD_KEYS.some((key) => fields[key] !== undefined);
}

/**
 * A stable fingerprint of what a write would change.
 *
 * Bound into the approval's resource key, so a confirmation issued for one set
 * of changes cannot execute a different one. Only keys the caller actually
 * passed are hashed — an omitted key contributes nothing, which is what keeps
 * "change the title" from digesting identically to "change the title and clear
 * the note".
 */
export function changeDigest(fields: ContactFields): string {
  const present: [string, unknown][] = [];
  for (const key of CONTACT_FIELD_KEYS) {
    const value = fields[key];
    if (value === undefined) continue;
    present.push([key, value === null ? '\u0000null' : value]);
  }
  present.sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256')
    .update(JSON.stringify(present))
    .digest('hex')
    .slice(0, 16);
}

/**
 * The same fingerprint, over one string.
 *
 * For `raw_vcard`, which is not a field set and cannot go through
 * {@link changeDigest}. It was bound by its **length** at first, which is not a
 * fingerprint at all — two whole-card replacements of equal size share a
 * resource key, and padding a vCard to an exact length is one `X-` property.
 * On the two-call-token path that is a substitution: approve a harmless card,
 * then send a hostile one of the same length with the token that came back.
 * The invariant on {@link changeDigest} has to hold for this branch too, or it
 * holds for the branch an attacker will not use.
 */
export function textDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * One optional, nullable argument, spelled so no two of its three states can
 * produce the same text.
 *
 * The same job {@link changeDigest} does for a field set, for the tools that
 * assemble a resource key by hand. Getting it wrong is not cosmetic: with
 * `undefined` encoded as `''` and `null` as `' null'`, a token issued for
 * `{name}` alone also executed `{name, note: ''}` — and clearing a note is a
 * removal a CardDAV server cannot undo. `\u0000` is the discriminator because
 * `schema.ts` refuses a control character on the way in, so no caller value can
 * spell one; a printable sentinel is merely unlikely to collide, which is a
 * different property.
 */
export function keyPart(value: string | null | undefined): string {
  if (value === undefined) return '\u0000absent';
  if (value === null) return '\u0000null';
  return `s:${value}`;
}

/**
 * A resource key whose parts are bound to their *positions*.
 *
 * `setResourceKey` sorts its targets before hashing — it is written for sets,
 * where `["5","12"]` and `["12","5"]` are the same thing. The keys here are
 * tuples, and sorting a tuple throws its positions away: `update_group` put
 * `keyPart(name)` and `keyPart(note)` in the same list, both spelled
 * `s:<text>`, so a token issued for `{name: "Team", note: "internal"}` also
 * executed `{name: "internal", note: "Team"}`; `move_contact` put the source
 * and the destination in one list, so an approval to move a card from Work to
 * Private also authorised moving a card of the same name from Private to
 * Work. Each part is prefixed with its index and a NUL, which no part can
 * contain (`schema.ts` refuses control characters on the way in, and a path
 * with a NUL never leaves `entity-id.ts`), so two different tuples cannot
 * sort into the same set.
 */
export function orderedResourceKey(
  operation: string,
  parts: readonly string[]
): string {
  return setResourceKey(
    operation,
    parts.map((part, index) => `${index}\u0000${part}`)
  );
}

/** How many properties a write touches, for the approval dialog. */
export function changedFieldNames(fields: ContactFields): string[] {
  return CONTACT_FIELD_KEYS.filter((key) => fields[key] !== undefined);
}

/**
 * The five components of `N`, or five empty strings.
 *
 * `readStructured` already does this and already survives a value ical.js
 * cannot decorate; a second implementation here was a copy that would have
 * drifted.
 */
function structuredNameOf(card: ICAL.Component): string[] {
  const parts = readStructured(card, 'n', 5);
  return parts.length === 5 ? parts : ['', '', '', '', ''];
}

/**
 * Applies the caller's fields to a card, in place.
 *
 * `N` and `ORG` are handled component-wise rather than wholesale: a caller
 * setting only `family_name` must not lose the given name that was already
 * there, and the same for a department beside an organisation.
 */
export function applyFields(
  card: ICAL.Component,
  fields: ContactFields
): { notes: string[] } {
  const notes: string[] = [];
  const version = versionOf(card);

  writeText(card, 'fn', fields.formatted_name);
  writeText(card, 'nickname', fields.nickname);
  writeText(card, 'title', fields.title);
  writeText(card, 'role', fields.role);
  writeText(card, 'note', fields.note);

  // N, component by component.
  const nameKeys = [
    'family_name',
    'given_name',
    'additional_names',
    'name_prefix',
    'name_suffix',
  ] as const;
  if (nameKeys.some((key) => fields[key] !== undefined)) {
    const current = structuredNameOf(card);
    const next = nameKeys.map((key, index) => {
      const value = fields[key];
      if (value === undefined) return current[index] ?? '';
      return value === null ? '' : value;
    });
    writeStructured(card, 'n', next.every((part) => part === '') ? null : next);
  }

  // ORG, likewise.
  if (fields.organization !== undefined || fields.department !== undefined) {
    const parts = readStructured(card, 'org', 2);
    const at = (index: number): string => parts[index] ?? '';
    const organization =
      fields.organization === undefined ? at(0) : (fields.organization ?? '');
    const department =
      fields.department === undefined ? at(1) : (fields.department ?? '');
    writeStructured(
      card,
      'org',
      organization === '' && department === ''
        ? null
        : department === ''
          ? [organization]
          : [organization, department],
      // ORG is structured but not multi-value; see `writeStructured`.
      { nested: false }
    );
  }

  writeTyped(card, 'email', fields.emails);
  writeTyped(card, 'tel', fields.phones);
  writeTyped(card, 'url', fields.urls);
  writeTyped(card, 'impp', fields.instant_messaging);

  if (fields.addresses !== undefined) {
    card.removeAllProperties('adr');
    for (const address of fields.addresses ?? []) {
      writeAddress(card, address);
    }
  }

  writeMultiValue(card, 'categories', fields.categories);

  for (const [key, property] of [
    ['birthday', 'bday'],
    ['anniversary', 'anniversary'],
  ] as const) {
    const value = fields[key];
    if (value === undefined) continue;
    card.removeAllProperties(property);
    if (value === null) continue;
    const { value: text, substitutedYear } = formatDate(value, version);
    const prop = new ICAL.Property(property, card);
    // `VALUE=date` is what a 3.0 client expects and what makes the value
    // unambiguous; 4.0's `date-and-or-time` is the default and needs no
    // parameter.
    if (version === '3.0') prop.setParameter('value', 'date');
    prop.setValue(text);
    card.addProperty(prop);
    if (substitutedYear) {
      notes.push(
        `vCard 3.0 has no syntax for a date without a year, so ${property.toUpperCase()} ` +
          'was written as 1604 — the placeholder clients use for exactly this ' +
          'case. It is not a claim about the year.'
      );
    }
  }

  return { notes };
}

function writeAddress(card: ICAL.Component, address: AddressInput): void {
  const prop = new ICAL.Property('adr', card);
  if (address.type !== undefined && address.type.trim().length > 0) {
    prop.setParameter('type', address.type.trim().toUpperCase());
  }
  // Folded like every other writer. The schema already refuses a control
  // character in an address component, so this is symmetry rather than a
  // fix — the one serialiser that did not fold was the one a reader had to
  // reason about separately.
  prop.setValues([
    [
      address.po_box ?? '',
      address.extended ?? '',
      address.street ?? '',
      address.locality ?? '',
      address.region ?? '',
      address.postal_code ?? '',
      address.country ?? '',
    ].map((part) => foldNewlines(part)),
  ] as never);
  card.addProperty(prop);
}

/**
 * The version a new card is written in.
 *
 * The collection decides where it says something: a book advertising only 4.0
 * gets 4.0. Otherwise 3.0, for the compatibility reason in `vcard.ts`.
 */
export function versionFor(book: AddressBookEntry): VCardVersion {
  const versions = book.supportedTypes.map((type) => type.version);
  if (versions.length === 0) return DEFAULT_VERSION;
  if (versions.includes(DEFAULT_VERSION)) return DEFAULT_VERSION;
  return versions.includes('4.0') ? '4.0' : DEFAULT_VERSION;
}

/**
 * `FN` is mandatory in both versions, so a card without one is not a card.
 *
 * Derived from the name components when the caller gave those instead, which is
 * the common case — somebody passing `given_name` and `family_name` should not
 * have to also spell out the display name. Given neither, this refuses rather
 * than storing a nameless entry that every client shows as a blank row.
 */
export function ensureFormattedName(card: ICAL.Component): void {
  if (readText(card, 'fn') !== undefined) return;
  const [family, given, additional, prefix, suffix] = structuredNameOf(card);
  const derived = [prefix, given, additional, family, suffix]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(' ');
  if (derived.length === 0) {
    throw new ToolInputError(
      'carddav-mcp: a contact needs a name. Pass formatted_name, or ' +
        'given_name and family_name for this server to build one from.'
    );
  }
  card.updatePropertyWithValue('fn', derived);
}

/** Refuses a write to a collection the server said is read-only. */
export function assertWritable(book: AddressBookEntry): void {
  if (book.readOnly) {
    throw new ToolInputError(
      `carddav-mcp: ${book.path} is read-only for this account, so nothing ` +
        'can be written to it. list_address_books marks such books read_only.'
    );
  }
}

/** Refuses a card larger than the collection accepts, before sending it. */
export function assertFits(book: AddressBookEntry, vcf: string): void {
  const limit = book.maxResourceSize;
  if (limit === undefined) return;
  const size = Buffer.byteLength(vcf, 'utf8');
  if (size > limit) {
    throw new ToolInputError(
      `carddav-mcp: the card is ${size} bytes and ${book.path} accepts at ` +
        `most ${limit}. An inline PHOTO is almost always the reason.`
    );
  }
}

/** Creates a card, refusing to overwrite anything that is already there. */
export async function createCard(
  api: CardDavApi,
  book: AddressBookEntry,
  card: ICAL.Component
): Promise<{ resourceName: string; etag: string | undefined; uid: string }> {
  assertWritable(book);
  ensureFormattedName(card);
  // Kept where the card has one: a pasted export keeps its identity, which is
  // what makes an import round-trip rather than duplicate. SECURITY.md says
  // so; `memberIndex` reports the collision a reused UID can cause.
  const uid = readText(card, 'uid') ?? newUid();
  card.updatePropertyWithValue('uid', uid);
  touch(card);
  const vcf = serializeVCard(card);
  assertFits(book, vcf);
  const resourceName = resourceNameFor(newUid());
  const url = resourceUrl(book, resourceName);
  const { etag } = await api.put(url, vcf, { create: true });
  return { resourceName, etag, uid };
}

/**
 * Replaces a card, guarded by the ETag it was read with.
 *
 * A missing ETag is a refusal rather than an unguarded write. The server either
 * did not send one or sent a weak one, and in both cases there is no way to
 * tell a concurrent edit from a clean write — see `normaliseEtag` in `api.ts`.
 * Writing anyway would silently discard whatever the other client just saved.
 */
export async function replaceCard(
  api: CardDavApi,
  book: AddressBookEntry,
  resourceName: string,
  card: ICAL.Component,
  etag: string | undefined
): Promise<{ etag: string | undefined }> {
  assertWritable(book);
  ensureFormattedName(card);
  if (etag === undefined) {
    throw new PreconditionFailedError(
      'carddav-mcp: this server would not be able to tell a concurrent edit ' +
        'from a clean write, because the CardDAV server sent no usable ETag ' +
        'for the card (a weak validator does not count). Nothing was written.'
    );
  }
  touch(card);
  const vcf = serializeVCard(card);
  assertFits(book, vcf);
  const url = resourceUrl(book, resourceName);
  const { etag: next } = await api.put(url, vcf, { ifMatch: etag });
  return { etag: next };
}

/** Deletes a card, guarded by the ETag it was read with. */
export async function deleteCard(
  api: CardDavApi,
  book: AddressBookEntry,
  resourceName: string,
  etag: string | undefined
): Promise<void> {
  assertWritable(book);
  if (etag === undefined) {
    throw new PreconditionFailedError(
      'carddav-mcp: the CardDAV server sent no usable ETag for this card, so ' +
        'a delete could not be guarded against a concurrent edit. Nothing was ' +
        'deleted.'
    );
  }
  const url = resourceUrl(book, resourceName);
  await api.del(url, etag);
}

/**
 * Parses a caller-supplied raw vCard and checks it is usable.
 *
 * The `uid` is taken from the card where it has one and generated otherwise, so
 * a caller pasting an export keeps its identity — which is what makes an import
 * round-trip rather than duplicating.
 */
export function cardFromRaw(raw: string): ICAL.Component {
  const card = parseVCard(raw, 'the raw_vcard argument');
  // A group card is not a contact, and the two tools that take `raw_vcard`
  // are contact tools: `create_contact` would otherwise create a group past
  // `create_group`'s convention choice, and `update_contact` would turn a
  // contact into a group under a dialog that said "replace a contact card".
  if (isGroup(card)) {
    throw new ToolInputError(
      'carddav-mcp: raw_vcard is a group card (KIND:group or ' +
        'X-ADDRESSBOOKSERVER-KIND:group), and this tool writes contacts. ' +
        'Use create_group or update_group for a group.'
    );
  }
  ensureFormattedName(card);
  return card;
}

/** A brand-new empty card at the right version for the collection. */
export function blankCard(book: AddressBookEntry): ICAL.Component {
  return newVCard(newUid(), versionFor(book));
}
