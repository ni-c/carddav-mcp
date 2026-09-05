import { assess, sanitizeText, stripInvisible } from './analyze.js';
import type { AddressBookEntry } from './books.js';
import { buildEntityId } from './entity-id.js';
import {
  groupModelOf,
  membersOf,
  memberUid,
  photoInfo,
  propertyValue,
  readDate,
  readList,
  readStructured,
  readText,
  readTyped,
  typesOf,
  versionOf,
  type ICAL,
} from './vcard.js';

/**
 * Turning a parsed card into the object a tool answers with.
 *
 * Every string that came out of a vCard passes through `stripInvisible` or
 * `sanitizeText` on its way here — a contact's own name is somebody else's text
 * as much as a note is, and a `FN` carrying a directional override renders as a
 * different person in the client that displays it.
 *
 * The projection *is* the schema: `output-schema.ts` names the same fields with
 * the same optionality, and where the two would drift the schema is what fails
 * the call. So a field added here without a line there is a broken tool, not an
 * undocumented one.
 */

/** Properties this server reads by name. Anything else is reported by name only. */
const KNOWN_PROPERTIES = new Set([
  'version',
  'uid',
  'fn',
  'n',
  'nickname',
  'org',
  'title',
  'role',
  'email',
  'tel',
  'adr',
  'url',
  'impp',
  'note',
  'categories',
  'bday',
  'anniversary',
  'photo',
  'rev',
  'kind',
  'member',
  'x-addressbookserver-kind',
  'x-addressbookserver-member',
]);

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = stripInvisible(value).trim();
  return text.length > 0 ? text : undefined;
}

function cleanList(values: readonly string[]): string[] {
  return values
    .map((value) => clean(value))
    .filter((value): value is string => value !== undefined);
}

function shapeTyped(
  entries: readonly { value: string; types: string[]; preferred: boolean }[]
): { value: string; types: string[]; preferred: boolean }[] {
  return entries
    .map((entry) => ({
      value: clean(entry.value) ?? '',
      types: entry.types,
      preferred: entry.preferred,
    }))
    .filter((entry) => entry.value.length > 0);
}

/** The five components of `N`, dropped when the card carries none. */
function shapeName(card: ICAL.Component): Record<string, string> | undefined {
  const parts = readStructured(card, 'n', 5);
  if (parts.length === 0) return undefined;
  const [family, given, additional, prefix, suffix] = parts;
  const out: Record<string, string> = {};
  const set = (key: string, value: string | undefined): void => {
    const text = clean(value);
    if (text !== undefined) out[key] = text;
  };
  set('family', family);
  set('given', given);
  set('additional', additional);
  set('prefix', prefix);
  set('suffix', suffix);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * `ORG` is a structured property whose first component is the organisation and
 * whose second is the unit. Most clients write only the first, and a few write
 * `Acme;Research` — reading it as one string would then produce `Acme;Research`
 * as the company name.
 */
function shapeOrg(card: ICAL.Component): {
  organization?: string;
  department?: string;
} {
  const parts = readStructured(card, 'org', 2);
  if (parts.length === 0) return {};
  const organization = clean(parts[0]);
  const department = clean(parts[1]);
  return {
    ...(organization === undefined ? {} : { organization }),
    ...(department === undefined ? {} : { department }),
  };
}

/** The seven components of `ADR`, per occurrence. */
function shapeAddresses(card: ICAL.Component): Record<string, unknown>[] {
  return card.getAllProperties('adr').map((prop) => {
    const raw = propertyValue(prop);
    const parts = Array.isArray(raw) ? raw : [raw];
    const at = (index: number): string | undefined => {
      const part = parts[index];
      const text = Array.isArray(part)
        ? part.map((entry) => String(entry)).join(', ')
        : String(part ?? '');
      return clean(text);
    };
    const label = prop.getParameter('label');
    const entry: Record<string, unknown> = {
      types: typesOf(prop),
      preferred:
        typesOf(prop).includes('pref') ||
        String(prop.getParameter('pref') ?? '') === '1',
    };
    const set = (key: string, value: string | undefined): void => {
      if (value !== undefined) entry[key] = value;
    };
    set('po_box', at(0));
    set('extended', at(1));
    set('street', at(2));
    set('locality', at(3));
    set('region', at(4));
    set('postal_code', at(5));
    set('country', at(6));
    set(
      'label',
      label === undefined || label === null ? undefined : clean(String(label))
    );
    return entry;
  });
}

/** Property names on the card this server does not read by name. */
function otherProperties(card: ICAL.Component): string[] {
  const seen = new Set<string>();
  for (const prop of card.getAllProperties()) {
    const name = prop.name.toLowerCase();
    if (!KNOWN_PROPERTIES.has(name)) seen.add(name.toUpperCase());
  }
  return [...seen].sort();
}

/** What both projections build first. */
function shapeCommon(
  card: ICAL.Component,
  book: AddressBookEntry,
  resourceName: string,
  etag: string | undefined
): Record<string, unknown> {
  const id = buildEntityId(book.path, resourceName);
  const model = groupModelOf(card);
  const info = photoInfo(card);
  const name = shapeName(card);
  const org = shapeOrg(card);

  const out: Record<string, unknown> = {
    id,
    address_book: book.path,
    version: versionOf(card),
  };
  const set = (key: string, value: unknown): void => {
    if (value !== undefined) out[key] = value;
  };
  set('uid', clean(readText(card, 'uid')));
  set('etag', etag);
  set('formatted_name', clean(readText(card, 'fn')));
  set('name', name);
  set('nickname', clean(readText(card, 'nickname')));
  set('organization', org.organization);
  set('department', org.department);
  set('title', clean(readText(card, 'title')));
  set('role', clean(readText(card, 'role')));
  set('revised', clean(readText(card, 'rev')));

  const emails = shapeTyped(readTyped(card, 'email'));
  if (emails.length > 0) out.emails = emails;
  const phones = shapeTyped(readTyped(card, 'tel'));
  if (phones.length > 0) out.phones = phones;
  const categories = cleanList(
    readList(card, 'categories').flatMap((value) => value.split(','))
  );
  if (categories.length > 0) out.categories = categories;

  if (info !== undefined) {
    const photo: Record<string, unknown> = { storage: info.storage };
    if (info.mediaType !== undefined) photo.media_type = info.mediaType;
    if (info.bytes !== undefined) photo.bytes = info.bytes;
    if (info.uri !== undefined) photo.uri = info.uri;
    out.photo = photo;
  }

  if (model !== undefined) {
    out.is_group = true;
    out.member_count = membersOf(card).length;
  }

  return out;
}

/**
 * A contact as a listing reports it.
 *
 * `partial` says the card behind this entry was retrieved with only the summary
 * properties. See `SUMMARY_PROPS` in `dav-xml.ts` for why that matters and what
 * keeps it from reaching a write.
 */
export function shapeSummary(
  card: ICAL.Component,
  book: AddressBookEntry,
  resourceName: string,
  etag: string | undefined,
  partial: boolean
): Record<string, unknown> {
  const out = shapeCommon(card, book, resourceName, etag);
  if (partial) out.partial = true;
  return out;
}

/** The whole card, as `get_contact` returns it. */
export function shapeFull(
  card: ICAL.Component,
  book: AddressBookEntry,
  resourceName: string,
  etag: string | undefined
): Record<string, unknown> {
  const out = shapeCommon(card, book, resourceName, etag);

  const addresses = shapeAddresses(card);
  if (addresses.length > 0) out.addresses = addresses;
  const urls = shapeTyped(readTyped(card, 'url'));
  if (urls.length > 0) out.urls = urls;
  const impp = shapeTyped(readTyped(card, 'impp'));
  if (impp.length > 0) out.instant_messaging = impp;

  const birthday = readDate(card, 'bday');
  if (birthday !== undefined) out.birthday = birthday;
  const anniversary = readDate(card, 'anniversary');
  if (anniversary !== undefined) out.anniversary = anniversary;

  const note = readText(card, 'note');
  if (note !== undefined) out.note = sanitizeText(note);

  const others = otherProperties(card);
  if (others.length > 0) out.other_properties = others;

  const signals = assess(freeTextOf(card));
  if (signals.suspicious.length > 0 || signals.scriptMix.length > 0) {
    out.security = {
      suspicious: signals.suspicious,
      script_mix: signals.scriptMix,
    };
  }

  return out;
}

/**
 * Everything on the card a person wrote, joined for the injection scan.
 *
 * Deliberately more than `NOTE`. The shapes `analyze.ts` looks for turn up in
 * whichever field the writer could reach, and on a card imported from a phone
 * that is often `FN` or `ORG` — a display name is what a reader trusts to
 * decide who they are looking at, so it is the field worth spoofing.
 */
export function freeTextOf(card: ICAL.Component): string {
  return [
    readText(card, 'fn'),
    readText(card, 'nickname'),
    readText(card, 'org'),
    readText(card, 'title'),
    readText(card, 'role'),
    readText(card, 'note'),
    ...readList(card, 'categories'),
  ]
    .filter((value): value is string => value !== undefined)
    .join('\n');
}

/**
 * The text `get_contact` puts inside the nonce fence.
 *
 * Rendered as labelled lines rather than as the raw vCard: the fence exists so
 * a reader can see where somebody else's words begin and end, and a reader
 * skimming `NOTE:` folded across three content lines at 75 characters cannot.
 * The raw card is what `export_contacts` is for.
 */
export function fencedTextOf(card: ICAL.Component): string {
  const lines: string[] = [];
  const add = (label: string, value: string | undefined): void => {
    const text = clean(value);
    if (text !== undefined) lines.push(`${label}: ${text}`);
  };
  add('Name', readText(card, 'fn'));
  add('Nickname', readText(card, 'nickname'));
  add('Organisation', readText(card, 'org'));
  add('Title', readText(card, 'title'));
  add('Role', readText(card, 'role'));
  for (const email of readTyped(card, 'email')) {
    add(
      `Email${email.types.length > 0 ? ` (${email.types.join(', ')})` : ''}`,
      email.value
    );
  }
  for (const phone of readTyped(card, 'tel')) {
    add(
      `Phone${phone.types.length > 0 ? ` (${phone.types.join(', ')})` : ''}`,
      phone.value
    );
  }
  const categories = readList(card, 'categories');
  if (categories.length > 0) add('Categories', categories.join(', '));
  const note = readText(card, 'note');
  if (note !== undefined) {
    lines.push('Note:');
    lines.push(sanitizeText(note));
  }
  return lines.join('\n');
}

/** An address book, as `list_address_books` reports it. */
export function shapeAddressBook(
  book: AddressBookEntry
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: book.path,
    url: book.url,
    read_only: book.readOnly,
  };
  const set = (key: string, value: unknown): void => {
    if (value !== undefined) out[key] = value;
  };
  set('display_name', clean(book.displayName));
  set('description', clean(book.description));
  set('ctag', book.ctag);
  set('sync_token', book.syncToken);
  set('max_resource_size', book.maxResourceSize);
  const versions = book.supportedTypes.map((type) => type.version);
  if (versions.length > 0) out.supported_versions = [...new Set(versions)];
  return out;
}

/** A group card, with its membership resolved where the members are local. */
export function shapeGroup(
  card: ICAL.Component,
  book: AddressBookEntry,
  resourceName: string,
  etag: string | undefined,
  resolve: (uid: string) => { id: string; name: string | undefined } | undefined
): Record<string, unknown> {
  const model = groupModelOf(card) ?? 'apple';
  const references = membersOf(card);
  const members = references.map((reference) => {
    const uid = memberUid(reference);
    const found = uid === undefined ? undefined : resolve(uid);
    const entry: Record<string, unknown> = { reference };
    if (uid !== undefined) entry.uid = uid;
    if (found !== undefined) {
      entry.id = found.id;
      const name = clean(found.name);
      if (name !== undefined) entry.formatted_name = name;
    }
    return entry;
  });

  const out: Record<string, unknown> = {
    id: buildEntityId(book.path, resourceName),
    address_book: book.path,
    model,
    member_count: references.length,
    version: versionOf(card),
  };
  const set = (key: string, value: unknown): void => {
    if (value !== undefined) out[key] = value;
  };
  set('uid', clean(readText(card, 'uid')));
  set('etag', etag);
  set('name', clean(readText(card, 'fn')));
  const note = readText(card, 'note');
  if (note !== undefined) out.note = sanitizeText(note);
  set('revised', clean(readText(card, 'rev')));
  if (members.length > 0) out.members = members;
  return out;
}
