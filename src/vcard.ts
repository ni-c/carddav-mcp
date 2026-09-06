import { randomUUID } from 'node:crypto';

import ICAL from 'ical.js';

import { quoted } from './analyze.js';
import { ToolInputError, VCardError } from './errors.js';

/**
 * The vCard layer — the only file in this server that imports `ical.js`.
 *
 * Everything above it works with plain objects, which is what keeps the parser
 * replaceable and the shaping testable without building a document first.
 *
 * Two facts about ical.js's vCard support decide most of what is here, and both
 * were established against the library rather than read out of its docs:
 *
 * 1. **The design set is chosen from the *first* property.** ical.js decides
 *    between its `vcard3` and `vcard4` grammars by looking at whether property
 *    zero is `VERSION:4.0` — and the parser and the hydrated `Property` objects
 *    disagree about the fallback when it is neither. A card whose `VERSION`
 *    sits second is parsed under the 3.0 grammar and read back under the 4.0
 *    one, and the visible symptom is that `EMAIL` returns `undefined`: not an
 *    error, just a contact whose addresses have quietly vanished. RFC 6350
 *    requires `VERSION` first for 4.0 and convention puts it first for 3.0, but
 *    "most cards" is not "every card", and a card written years ago by some
 *    phone is exactly the input this server has to survive. {@link parseVCard}
 *    therefore hoists `VERSION` before wrapping the jCard, always.
 * 2. **`TYPE` is a string when there is one and an array when there are
 *    several.** `TEL;TYPE=WORK` yields `"WORK"`, `TEL;TYPE=WORK,VOICE` yields
 *    `["WORK","VOICE"]`, and the case is whatever the card used. Every reader
 *    goes through {@link typesOf}.
 */

/** The two vCard versions this server reads and writes. */
export type VCardVersion = '3.0' | '4.0';

/**
 * What this server writes when it creates a card and the collection does not
 * insist otherwise.
 *
 * 3.0 rather than 4.0, and it is a compatibility choice rather than a
 * standards one: Apple Contacts, Google Contacts and most phones read 3.0
 * completely and 4.0 partially. Where a collection's `supported-address-data`
 * says it only takes 4.0, the caller writes 4.0 instead; where a card already
 * exists, its own version is kept.
 */
export const DEFAULT_VERSION: VCardVersion = '3.0';

/**
 * Parses a vCard, refusing anything that is not one.
 *
 * The parser's own message is quoted only in part. ical.js repeats the
 * offending line verbatim, and that line is the one piece of the document most
 * under the control of whoever wrote it: unbounded, unsanitised, and about to
 * be delivered in this server's own voice outside any fence. A short, escaped
 * excerpt is enough to find the line; the document itself is not something to
 * paste into an error.
 */
export function parseVCard(vcf: string, what: string): ICAL.Component {
  let jcal: unknown;
  try {
    jcal = ICAL.parse(vcf);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new VCardError(
      `carddav-mcp: ${what} is not a readable vCard ` +
        `(${quoted(reason.replace(/\s+/g, ' '), 120)}).`,
      true
    );
  }
  if (!Array.isArray(jcal) || jcal[0] !== 'vcard') {
    throw new VCardError(`carddav-mcp: ${what} is not a VCARD document.`, true);
  }
  hoistVersion(jcal as [string, unknown[][], unknown[]]);
  return new ICAL.Component(jcal as never);
}

/**
 * Moves `VERSION` to the front of the property list, in place.
 *
 * See the note at the top of this file: this is not tidiness, it is what stops
 * ical.js reading a card under a different grammar than it parsed it with. It
 * operates on the raw jCard rather than on a `Component`, because the moment a
 * `Component` exists the wrong design set has already been chosen.
 */
function hoistVersion(jcal: [string, unknown[][], unknown[]]): void {
  const props = jcal[1];
  if (!Array.isArray(props)) return;
  const index = props.findIndex(
    (prop) => Array.isArray(prop) && prop[0] === 'version'
  );
  if (index > 0) {
    const [version] = props.splice(index, 1);
    if (version !== undefined) props.unshift(version);
  }
}

/** Serialises a card back to the wire form. */
export function serializeVCard(card: ICAL.Component): string {
  return card.toString();
}

/**
 * The card's version, defaulting to 3.0.
 *
 * RFC 6350 makes `VERSION` mandatory and RFC 2426 does too, but a card missing
 * it is a card that exists in the wild, and 3.0 is what a reader should assume:
 * 4.0 is the version that requires the property be present and first, so its
 * absence is evidence against 4.0.
 */
export function versionOf(card: ICAL.Component): VCardVersion {
  return readText(card, 'version') === '4.0' ? '4.0' : '3.0';
}

/**
 * Builds an empty card.
 *
 * `VERSION` is set first and `UID` second, in that order and deliberately: see
 * the note at the top of the file. A test asserts the serialised form opens
 * with `VERSION`.
 */
export function newVCard(uid: string, version: VCardVersion): ICAL.Component {
  const card = new ICAL.Component('vcard');
  card.updatePropertyWithValue('version', version);
  card.updatePropertyWithValue('uid', uid);
  return card;
}

/**
 * Stamps a card as changed.
 *
 * `REV` is vCard's only revision marker — there is no `SEQUENCE` and no
 * `LAST-MODIFIED`, and no scheduling protocol reads it, so unlike the calendar
 * case there is nothing here that a wrong value could mislead. Clients use it
 * to resolve a two-sided edit, which is reason enough to keep it current.
 *
 * **The value handed in has to be spelled per version, and getting it wrong
 * fails in two different ways — neither of them an error.** ical.js decorates
 * the value on the way in and re-serialises it canonically on the way out, so
 * what reaches the wire is not the string given here; what the string decides
 * is whether the decoration works. Measured against the library:
 *
 * | card | given | serialised | read back |
 * |---|---|---|---|
 * | 3.0 | `2026-09-05T23:05:16Z` | `20260905T230516Z` | fine |
 * | 3.0 | `20260905T230516Z` | **`20260905T23016Z`** | fine |
 * | 4.0 | `20260905T230516Z` | `20260905T230516Z` | fine |
 * | 4.0 | `2026-09-05T23:05:16Z` | `20260905T230516Z` | **throws** |
 *
 * The 3.0 row in bold is the dangerous one: a *silently corrupted* timestamp,
 * a digit short, written to the server and noticed by nobody. So 3.0 is fed
 * the extended form and 4.0 the basic one, and this branch is not cosmetic.
 */
export function touch(card: ICAL.Component): void {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const value = versionOf(card) === '4.0' ? now.replace(/[-:]/g, '') : now;
  card.updatePropertyWithValue('rev', value);
}

/** A fresh UID, and the resource name derived from it. */
export function newUid(): string {
  return randomUUID();
}

/**
 * The file name a new card is stored under.
 *
 * Derived from a fresh UUID rather than from the caller's data, so it carries
 * nothing about the person and needs no escaping. `.vcf` because that is what
 * every server and every client expects, even though nothing requires it.
 */
export function resourceNameFor(uid: string): string {
  return `${uid}.vcf`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The `TYPE` parameter, normalised to a lowercase array.
 *
 * One value arrives as a string and several as an array; the case is whatever
 * the writing client chose (`WORK` from most, `work` from a 4.0 client). Every
 * comparison in this server goes through here, because the alternative is a
 * `=== 'work'` somewhere that silently never matches.
 */
export function typesOf(prop: ICAL.Property): string[] {
  const raw = prop.getParameter('type');
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((entry) => String(entry).trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** Whether a property carries `TYPE=PREF` or `PREF=1` (the 4.0 spelling). */
export function isPreferred(prop: ICAL.Property): boolean {
  if (typesOf(prop).includes('pref')) return true;
  const pref = prop.getParameter('pref');
  return pref !== undefined && pref !== null && String(pref) === '1';
}

/**
 * A property's first value, falling back to the text the card actually holds.
 *
 * **Every read in this file goes through here, and that is not defensiveness
 * for its own sake.** ical.js decorates a typed value on access — a `BDAY` into
 * a date, a `REV` into a timestamp — and throws when the text does not fit the
 * grammar. Two situations make that a real failure rather than a theoretical
 * one:
 *
 * - **A card from the wild.** `BDAY:not-a-date` is legal text in a file some
 *   client wrote years ago, and an exception there does not lose one field, it
 *   takes `get_contact` down for the whole card.
 * - **A card this process just built.** For a vCard 4.0 card, ical.js types
 *   `REV` as a `timestamp` and *serialises* `20260905T225812Z` correctly —
 *   which is the only spelling the 4.0 grammar accepts — but reading the same
 *   value back off the in-memory object routes through the iCalendar
 *   date-time parser and throws. Round-tripping the card through its own wire
 *   form fixes it, which is the tell that this is a decoration bug rather than
 *   a bad value. `create_contact` against a 4.0 address book hit exactly this.
 *
 * The fallback is the raw jCal slot, which is the unparsed text — the honest
 * answer to "what does the card say" when the grammar cannot tell us what it
 * means.
 */
export function propertyValue(prop: ICAL.Property): unknown {
  try {
    return prop.getFirstValue();
  } catch {
    return (prop.jCal as unknown[])[3];
  }
}

/** Reads a text property, or undefined when it is absent or empty. */
export function readText(
  card: ICAL.Component,
  name: string
): string | undefined {
  const prop = card.getFirstProperty(name);
  if (prop === null || prop === undefined) return undefined;
  const value = propertyValue(prop);
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

/** Every value of a property that may appear more than once. */
export function readList(card: ICAL.Component, name: string): string[] {
  return card
    .getAllProperties(name)
    .map((prop) => String(propertyValue(prop) ?? '').trim())
    .filter((value) => value.length > 0);
}

/** One typed value — an email address, a phone number, a URL. */
export interface TypedValue {
  value: string;
  /** The `TYPE` parameter, lowercased. Empty when the card named none. */
  types: string[];
  preferred: boolean;
}

/** Every occurrence of a typed property, in document order. */
export function readTyped(card: ICAL.Component, name: string): TypedValue[] {
  return card
    .getAllProperties(name)
    .map((prop) => ({
      value: String(propertyValue(prop) ?? '').trim(),
      types: typesOf(prop),
      preferred: isPreferred(prop),
    }))
    .filter((entry) => entry.value.length > 0);
}

/**
 * A structured property's components, as a fixed-length array of strings.
 *
 * `N` has five components and `ADR` seven. ical.js hands back an array, but a
 * card written by hand can carry fewer components than the grammar wants, and
 * a component that itself repeats (`ADR` allows a comma list inside a
 * component) arrives as a nested array. Both are flattened to a string here so
 * that every reader downstream sees the same shape.
 */
export function readStructured(
  card: ICAL.Component,
  name: string,
  length: number
): string[] {
  const prop = card.getFirstProperty(name);
  if (prop === null || prop === undefined) return [];
  const raw = propertyValue(prop);
  const parts = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const part = parts[index];
    out.push(
      Array.isArray(part)
        ? part.map((entry) => String(entry)).join(', ')
        : String(part ?? '')
    );
  }
  return out;
}

/**
 * A vCard date, which is very often not a complete one.
 *
 * `BDAY:--0415` means "the fifteenth of April, year unknown" and is what a
 * phone writes when the contact's birth year was never entered — a large share
 * of the real birthdays in any address book. Mapping that to `null` throws away
 * a fact the card states; inventing a year states one it does not.
 *
 * `raw` is kept beside the parsed parts because some cards carry a free-text
 * date the grammar does not cover at all (RFC 6350 permits `BDAY;VALUE=text`),
 * and because a reader occasionally wants to see what was actually written.
 */
export interface PartialDate {
  year?: number;
  month?: number;
  day?: number;
  /** Exactly as the card spells it. */
  raw: string;
}

/**
 * Reads `BDAY` or `ANNIVERSARY`.
 *
 * Both `VALUE=date` in 3.0 and the 4.0 `date-and-or-time` land here. A
 * `VALUE=text` date — "the second Tuesday of Advent" — has no parts and is
 * returned as `raw` alone rather than dropped.
 */
export function readDate(
  card: ICAL.Component,
  name: string
): PartialDate | undefined {
  const prop = card.getFirstProperty(name);
  if (prop === null || prop === undefined) return undefined;
  const value = propertyValue(prop);
  if (value === null || value === undefined) return undefined;
  const raw = String(value).trim();
  if (raw.length === 0) return undefined;

  // ical.js hands back a VCardTime for a date-shaped value and a plain string
  // for a text one. The nulls are the whole point: a reduced-accuracy date
  // carries only the parts it states.
  const parts = value as {
    year?: number | null;
    month?: number | null;
    day?: number | null;
  };
  // Each part is bound once and then spread conditionally. Under
  // `exactOptionalPropertyTypes` an optional property has to be *absent*
  // rather than explicitly `undefined`, and calling `numericPart()` twice
  // inside the ternary does not narrow — the value TypeScript sees in the
  // object literal is still `number | undefined`.
  const year = numericPart(parts.year);
  const month = numericPart(parts.month);
  const day = numericPart(parts.day);

  return {
    ...(year === undefined ? {} : { year }),
    ...(month === undefined ? {} : { month }),
    ...(day === undefined ? {} : { day }),
    raw,
  };
}

function numericPart(part: number | null | undefined): number | undefined {
  return typeof part === 'number' && Number.isFinite(part) ? part : undefined;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Writes `BDAY` or `ANNIVERSARY` from a structured date.
 *
 * The spelling depends on the version and on which parts are present:
 * a complete date is `1815-12-10` in 3.0 and `18151210` in 4.0, and a date
 * without a year is `--1210` in 4.0 while **3.0 has no syntax for it at all**.
 * RFC 2426 defines `BDAY` as a complete ISO 8601 date, so a 3.0 card given a
 * yearless birthday gets the placeholder year clients settled on for exactly
 * this case — 1604 — rather than a value the grammar rejects. It is recorded
 * in the result so nobody mistakes it for a fact about the person.
 */
export function formatDate(
  date: {
    year?: number | undefined;
    month?: number | undefined;
    day?: number | undefined;
  },
  version: VCardVersion
): { value: string; substitutedYear: boolean } {
  const { year, month, day } = date;
  if (month === undefined || day === undefined) {
    throw new ToolInputError(
      'carddav-mcp: a date needs at least a month and a day. Pass ' +
        '{ month, day } for a birthday whose year is unknown.'
    );
  }
  if (year === undefined) {
    if (version === '4.0') {
      return { value: `--${pad(month)}${pad(day)}`, substitutedYear: false };
    }
    return { value: `1604-${pad(month)}-${pad(day)}`, substitutedYear: true };
  }
  const yyyy = String(year).padStart(4, '0');
  return {
    value:
      version === '4.0'
        ? `${yyyy}${pad(month)}${pad(day)}`
        : `${yyyy}-${pad(month)}-${pad(day)}`,
    substitutedYear: false,
  };
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

/** What `get_contact` reports about a `PHOTO`, without carrying its bytes. */
export interface PhotoInfo {
  /** `inline` for embedded base64, `uri` for a link this server never follows. */
  storage: 'inline' | 'uri';
  mediaType: string | undefined;
  /** Decoded size, for an inline photo. */
  bytes: number | undefined;
  /** The address, for a photo stored as a link. Reported, never fetched. */
  uri: string | undefined;
}

/**
 * Describes the `PHOTO` without decoding it into the answer.
 *
 * The line this draws is the one the sister server draws for `ATTACH`: a
 * picture is reported as metadata and delivered only when a tool is asked for
 * it by name. Two reasons, and the second is the one that matters. A photo is
 * tens to hundreds of kilobytes of base64, so putting it in every `get_contact`
 * would spend a context window on data nobody asked for. And a `PHOTO` given as
 * a URI is an address somebody else chose — fetching it would make this server
 * a request forwarder pointed at an arbitrary host, which is precisely the
 * boundary `openWorldHint` marks and this server does not cross.
 */
export function photoInfo(card: ICAL.Component): PhotoInfo | undefined {
  const prop = card.getFirstProperty('photo');
  if (prop === null || prop === undefined) return undefined;
  const raw = String(propertyValue(prop) ?? '');
  if (raw.length === 0) return undefined;

  const dataUri = /^data:([^;,]*)(;base64)?,/i.exec(raw);
  if (dataUri) {
    const mediaType = (dataUri[1] ?? '').toLowerCase() || undefined;
    const payload = raw.slice(dataUri[0].length);
    return {
      storage: 'inline',
      mediaType,
      bytes: base64Bytes(payload),
      uri: undefined,
    };
  }

  // vCard 3.0: `PHOTO;ENCODING=b;TYPE=JPEG:<base64>`. The `TYPE` is a bare
  // format name rather than a media type, which is why it is mapped rather
  // than used.
  const encoding = String(prop.getParameter('encoding') ?? '').toLowerCase();
  if (encoding === 'b' || encoding === 'base64') {
    return {
      storage: 'inline',
      mediaType: mediaTypeOf(prop),
      bytes: base64Bytes(raw),
      uri: undefined,
    };
  }

  return {
    storage: 'uri',
    mediaType: mediaTypeOf(prop),
    bytes: undefined,
    uri: raw,
  };
}

/**
 * The inline photo's bytes, for `get_contact_photo` and nothing else.
 *
 * Returns undefined for a photo stored as a URI — that is the case the tool
 * refuses with an explanation rather than by fetching.
 */
export function photoBytes(
  card: ICAL.Component
): { data: Buffer; mediaType: string } | undefined {
  const info = photoInfo(card);
  if (info === undefined || info.storage !== 'inline') return undefined;
  const prop = card.getFirstProperty('photo');
  if (prop === null || prop === undefined) return undefined;
  const raw = String(propertyValue(prop) ?? '');
  const payload = /^data:[^,]*,/i.test(raw)
    ? raw.slice(raw.indexOf(',') + 1)
    : raw;
  // `base64` is lenient about characters outside the alphabet, which is the
  // right behaviour here: a stored photo with a stray newline is a photo, not
  // an attack, and nothing downstream interprets these bytes.
  const data = Buffer.from(payload, 'base64');
  if (data.byteLength === 0) return undefined;
  // The media type is decided by the **bytes**, never by what the card claims.
  // `info.mediaType` comes straight out of `data:<here>;base64,` or a
  // `MEDIATYPE=` parameter, and it lands on an `image` content block that a
  // client may render in a webview using exactly that type. `text/html` and
  // `image/svg+xml` are both reachable that way — verified — and an SVG is a
  // document with a `<script>` element, not a photo. So: sniff, allow four
  // raster formats, and hand over nothing else. Bytes that are not one of the
  // four used to go out as `application/octet-stream` in an `image` block — a
  // label a client that saves the block and opens it by its own sniffing
  // does not read — and there is no photo to show in that case anyway.
  const mediaType = sniffImageType(data);
  if (mediaType === undefined) return undefined;
  return { data, mediaType };
}

/**
 * The media type a buffer actually is, for the four raster formats worth
 * rendering.
 *
 * Deliberately shorter than {@link mediaTypeOf}'s map: this decides what a
 * client is told to render, where that one only reports what a card claims.
 * TIFF and BMP are dropped because nothing renders them inline anyway, and SVG
 * because it is scriptable. Anything else is not delivered at all — see
 * {@link photoBytes}.
 */
export function sniffImageType(data: Buffer): string | undefined {
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_MAGIC))
    return 'image/png';
  if (data.length >= 6) {
    const head = data.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Maps a 3.0 `TYPE=JPEG` or a 4.0 `MEDIATYPE=` onto a media type. */
function mediaTypeOf(prop: ICAL.Property): string | undefined {
  const explicit = prop.getParameter('mediatype');
  if (explicit !== undefined && explicit !== null) {
    return String(explicit).toLowerCase();
  }
  const format = String(prop.getParameter('type') ?? '')
    .toLowerCase()
    .replace(/^image\//, '');
  if (format.length === 0) return undefined;
  // `Object.hasOwn`, because `format` is a string the card's author chose and
  // the table is an object literal with a prototype. `TYPE=constructor` used
  // to return `Object` itself — a function where the declared type promised a
  // string — and the projection's `sanitizeShortText` then threw
  // `input.normalize is not a function` out of every listing that card was in.
  return Object.hasOwn(KNOWN_PHOTO_FORMATS, format)
    ? KNOWN_PHOTO_FORMATS[format]
    : undefined;
}

/** Maps a 3.0 `TYPE=` format name onto a media type. */
const KNOWN_PHOTO_FORMATS: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

/**
 * Decoded size of a base64 payload, without decoding it.
 *
 * The padding used to be measured with `/=*$/`, and that regex is quadratic:
 * unanchored at the start, it is tried from every position of a run of `=`,
 * and each attempt consumes the run to its end before `$` fails on the byte
 * after it. A card carrying 80 000 `=` in its `PHOTO` — which anyone with write
 * access to a shared address book can store — cost two seconds here, on the
 * thread that serves every request, and a card at the 1 MiB read ceiling cost
 * minutes. Base64 padding is at most two characters, so two `endsWith` calls
 * answer the question in constant time.
 */
function base64Bytes(payload: string): number {
  const clean = payload.replace(/\s+/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Folds every line break in a caller's text to LF, which ical.js escapes.
 *
 * ical.js escapes `\`, `;`, `,` and LF in a TEXT value and nothing else, so a
 * bare CR would go into the card as a raw CR — and a reader that splits content
 * lines on it sees a property nobody wrote. The schema refuses every other
 * control character outright; CR is folded rather than refused because a note
 * pasted from a Windows client legitimately carries CRLF.
 */
export function foldNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/** Sets a text property, or removes it when the value is null. */
export function writeText(
  card: ICAL.Component,
  name: string,
  value: string | null | undefined
): void {
  if (value === undefined) return;
  card.removeAllProperties(name);
  if (value === null) return;
  card.updatePropertyWithValue(name, foldNewlines(value));
}

/**
 * One typed value on the way in.
 *
 * `| undefined` is spelled out because `exactOptionalPropertyTypes` is on: a
 * caller that passes `{ value, type: undefined }` — which is what a zod-parsed
 * optional field looks like — must be assignable to the same type as one that
 * passes `{ value }`.
 */
export interface TypedInput {
  value: string;
  type?: string | undefined;
}

/** Replaces every occurrence of a typed property with the given list. */
export function writeTyped(
  card: ICAL.Component,
  name: string,
  entries: readonly TypedInput[] | null | undefined
): void {
  if (entries === undefined) return;
  card.removeAllProperties(name);
  if (entries === null) return;
  for (const entry of entries) {
    const prop = new ICAL.Property(name, card);
    if (entry.type !== undefined && entry.type.trim().length > 0) {
      prop.setParameter('type', entry.type.trim().toUpperCase());
    }
    prop.setValue(foldNewlines(entry.value));
    card.addProperty(prop);
  }
}

/**
 * Replaces a structured property with the given components.
 *
 * ical.js draws a distinction here that is invisible from the outside and
 * throws when it is got wrong. `N` and `ADR` are declared
 * `structuredValue: ';'` **and** `multiValue: ','`, so each component may
 * itself be a list and the value has to be nested one level. `ORG` is declared
 * structured only, and handing it the nested form fails with
 * `org: does not not support mulitValue` — the library's own typo, and the
 * only warning anyone gets.
 */
export function writeStructured(
  card: ICAL.Component,
  name: string,
  parts: readonly string[] | null | undefined,
  options: { type?: string; nested?: boolean } = {}
): void {
  if (parts === undefined) return;
  card.removeAllProperties(name);
  if (parts === null) return;
  const prop = new ICAL.Property(name, card);
  if (options.type !== undefined && options.type.trim().length > 0) {
    prop.setParameter('type', options.type.trim().toUpperCase());
  }
  const folded = parts.map((part) => foldNewlines(part));
  if (options.nested === false) {
    // A structured-only property holds one value that happens to be an array,
    // so it is `setValue`. `setValues` is the multi-value setter and refuses
    // outright here — which is the failure the docblock above describes.
    prop.setValue(folded as never);
  } else {
    prop.setValues([folded] as never);
  }
  card.addProperty(prop);
}

/**
 * Replaces a comma-separated multi-value property, `CATEGORIES` being the one.
 *
 * Joining the list into one string and letting ical.js escape it produces a
 * single category called `one\,two`, which is a different thing from two
 * categories and reads correctly in no client.
 */
export function writeMultiValue(
  card: ICAL.Component,
  name: string,
  values: readonly string[] | null | undefined
): void {
  if (values === undefined) return;
  card.removeAllProperties(name);
  if (values === null || values.length === 0) return;
  const prop = new ICAL.Property(name, card);
  prop.setValues(values.map((value) => foldNewlines(value)) as never);
  card.addProperty(prop);
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/**
 * Which of the two incompatible group conventions a card uses.
 *
 * vCard 4.0 defines `KIND:group` with `MEMBER` properties (RFC 6350 §6.1.4,
 * §6.6.5). Apple got there first and shipped `X-ADDRESSBOOKSERVER-KIND:group`
 * with `X-ADDRESSBOOKSERVER-MEMBER` on top of vCard 3.0, and that is what
 * Apple Contacts, Nextcloud and most of the installed base actually store —
 * including servers that would happily accept the 4.0 spelling.
 *
 * This server reads both and writes whichever the surrounding address book
 * already uses, because a group written in the other convention is invisible
 * to the client the person is looking at. Where a book has no groups yet, the
 * card's version decides: `apple` for a 3.0 book, `rfc` for a 4.0 one.
 */
export type GroupModel = 'rfc' | 'apple';

const APPLE_KIND = 'x-addressbookserver-kind';
const APPLE_MEMBER = 'x-addressbookserver-member';

/** The convention a card is written in, or undefined when it is not a group. */
export function groupModelOf(card: ICAL.Component): GroupModel | undefined {
  const appleKind = readText(card, APPLE_KIND)?.toLowerCase();
  if (appleKind === 'group') return 'apple';
  const kind = readText(card, 'kind')?.toLowerCase();
  if (kind === 'group') return 'rfc';
  // A card carrying members but no KIND is still a group in practice — some
  // clients omit the marker. Trusting the members rather than the marker means
  // a group written by such a client is not silently listed as a contact.
  if (card.getAllProperties(APPLE_MEMBER).length > 0) return 'apple';
  if (card.getAllProperties('member').length > 0) return 'rfc';
  return undefined;
}

/** Whether the card is a group under either convention. */
export function isGroup(card: ICAL.Component): boolean {
  return groupModelOf(card) !== undefined;
}

/**
 * The UIDs a group names, in document order.
 *
 * A member reference is a URI. `urn:uuid:<uid>` is what both conventions use
 * for a card in the same address book, and it is the only form this server
 * resolves; `mailto:` members are legal in 4.0 and are returned as written,
 * because resolving one means searching by address and guessing which card was
 * meant.
 */
export function membersOf(card: ICAL.Component): string[] {
  const model = groupModelOf(card);
  if (model === undefined) return [];
  return readList(card, model === 'apple' ? APPLE_MEMBER : 'member');
}

/** Strips the `urn:uuid:` prefix, leaving anything else as it is. */
export function memberUid(reference: string): string | undefined {
  const match = /^urn:uuid:(.+)$/i.exec(reference.trim());
  return match?.[1];
}

/** Marks a card as a group in the given convention. */
export function markAsGroup(card: ICAL.Component, model: GroupModel): void {
  card.removeAllProperties('kind');
  card.removeAllProperties(APPLE_KIND);
  card.updatePropertyWithValue(
    model === 'apple' ? APPLE_KIND : 'kind',
    'group'
  );
}

/**
 * Replaces a group's membership.
 *
 * Both property names are cleared regardless of the model, so a card that
 * somehow carries members in both conventions cannot come out of an edit with
 * one set updated and the other stale — which would read as a group whose
 * membership depends on which client is asking.
 */
export function setMembers(
  card: ICAL.Component,
  model: GroupModel,
  uids: readonly string[]
): void {
  card.removeAllProperties('member');
  card.removeAllProperties(APPLE_MEMBER);
  const name = model === 'apple' ? APPLE_MEMBER : 'member';
  for (const uid of uids) {
    const reference = /^[a-z][a-z0-9+.-]*:/i.test(uid)
      ? uid
      : `urn:uuid:${uid}`;
    card.addPropertyWithValue(name, reference);
  }
}

export { ICAL };
