import { XMLParser } from 'fast-xml-parser';

/**
 * The WebDAV/CardDAV XML layer: request bodies out, multistatus documents in.
 *
 * Kept apart from `api.ts` because the two halves have different reasons to be
 * read. `api.ts` is about HTTP — timeouts, ceilings, redirects, TLS. This file
 * is about a document format, and it holds the one genuinely free-form value
 * this server ever puts on the wire (the `text-match` search string) plus the
 * decoder that turns somebody else's characters into ours. Both want their own
 * test file and byte-for-byte comparison against captured requests.
 */

/** Namespace prefixes this server emits. Fixed spelling, on purpose — see below. */
const NS =
  'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" ' +
  'xmlns:CS="http://calendarserver.org/ns/"';

/**
 * Every property this server ever asks for, as a closed union.
 *
 * Closed because it is what keeps the request bodies free of caller-supplied
 * names: a `PropName` cannot be a string that came in over the protocol, so the
 * only variable text in any body is the search term, which is escaped.
 */
export type PropName =
  | 'D:resourcetype'
  | 'D:displayname'
  | 'D:getetag'
  | 'D:getcontenttype'
  | 'D:getcontentlength'
  | 'D:current-user-principal'
  | 'D:principal-URL'
  | 'D:current-user-privilege-set'
  | 'D:sync-token'
  | 'C:addressbook-home-set'
  | 'C:addressbook-description'
  | 'C:supported-address-data'
  | 'C:max-resource-size'
  | 'C:address-data'
  | 'CS:getctag';

/**
 * Escapes a value for XML character data.
 *
 * Beyond the five built-ins this refuses control characters outright rather
 * than encoding them. XML 1.0 cannot represent most of them at all, and the two
 * that matter here — CR and LF — must never reach a `text-match` term, because
 * the server compares them against vCard content where a line break is
 * structural. Refusing is honest; encoding would invent a value the caller did
 * not send.
 */
export function escapeXmlText(value: string): string {
  // Everything in C0 except tab, plus DEL and C1. CR and LF are refused with
  // the rest, and that is the point rather than an oversight: a line break is
  // meaningless in a search term and structural in a vCard.
  // eslint-disable-next-line no-control-regex -- matching them is the point
  if (/[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/.test(value)) {
    throw new XmlValueError(
      'the value contains control characters, which cannot appear in a CardDAV ' +
        'request. Remove them and try again.'
    );
  }
  if (
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      value
    )
  ) {
    throw new XmlValueError(
      'the value contains an unpaired surrogate and is not valid text.'
    );
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Raised for a value that cannot legally be put into a request body. */
export class XmlValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlValueError';
  }
}

/**
 * Decodes the XML entities the parser deliberately left alone.
 *
 * The parser runs with `processEntities: false`, so every text node arrives
 * with `&amp;`, `&lt;`, `&#13;` and friends still in it. They have to be
 * decoded somewhere, and this is the somewhere.
 *
 * The control-character guard is the load-bearing part. Every value this
 * function is used on — a `displayname`, an href, a DAV error message — is one
 * this server treats as a single line, so a decoded CR or LF would end it and
 * start something the server never sent. A numeric reference to a C0/C1
 * character, a surrogate or an out-of-range code point is therefore emitted as
 * its literal source text instead of as a character: visible, inert, and
 * obviously wrong to a reader rather than silently effective.
 *
 * The one node this is *not* used on is `address-data`, whose content is a
 * document rather than a value — see {@link decodeAddressData}.
 */
export function decodeXmlText(value: string): string {
  return decode(value, 'refuse');
}

/**
 * The same, for the one node whose content **is** a document.
 *
 * Two things happen here that happen nowhere else, and both come from the same
 * property of `address-data`: it is a `stopNodes` entry, so the parser hands
 * back its **raw source** rather than its text.
 *
 * **The packaging comes with it.** Raw source means the XML syntax that carried
 * the document is still in the string — see {@link unwrapDocumentNode}, which
 * takes it back off.
 *
 * **The entities come with it too**, and one of them is load-bearing. sabre/dav
 * encodes the vCard's own line endings as `&#13;`, where Radicale writes them
 * raw; under a rule that refuses every control reference, every card sabre
 * returns reads `BEGIN:VCARD&#13;` and fails to parse. The integration suite
 * found that on its first run against Baikal, as three unreadable cards and an
 * empty listing.
 *
 * The rule is therefore `before-newline` rather than a blanket exception, and
 * the difference is the whole point. A server that encodes line endings emits
 * the reference **immediately before the real newline it stands for** — XML
 * normalises a raw CR to LF on the way in, so escaping it is the only way to
 * keep it, and legitimate rather than suspicious. A reference smuggled into a
 * *value* has no real newline behind it: `FN:harmless&#13;&#10;EMAIL:x@y.z`
 * stays literal and invents no second property. Same rule, same words, in
 * caldav-mcp — the two servers used to disagree here, and both docblocks
 * argued well for a rule that cannot be right in only one of them.
 *
 * Everything else stays refused: other C0 characters, C1, surrogates and
 * out-of-range references are emitted as their literal source text.
 */
export function decodeAddressData(value: string): string {
  return unwrapDocumentNode(value, (text) => decode(text, 'before-newline'));
}

/**
 * How a CR or LF reference is treated.
 *
 * - `refuse` — left as its literal source text. Every value outside the
 *   document node, where a decoded newline would end a line this server reads
 *   as one.
 * - `before-newline` — decoded only where a real newline follows it, the shape
 *   a server produces when it encodes its line endings. The document node, and
 *   nothing else.
 *
 * There is deliberately no third setting for "decode them wherever they are".
 * A server that encoded *both* halves of every line ending would leave no real
 * newline for the reference to sit in front of, and such a document would come
 * back as one unreadable line — but no server is known to do that, and the
 * relaxation that would cover it is exactly the one the smuggled-property test
 * exists to refuse. If a listing is ever empty against a server whose payload
 * is full of `&#13;&#10;`, this is the decision to revisit, with a test for
 * that server rather than a general loosening.
 */
type LineEndingPolicy = 'refuse' | 'before-newline';

const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

/**
 * Takes the XML packaging back off the raw source of a `stopNodes` node.
 *
 * `stopNodes` means "do not interpret this as markup", which is right — a
 * vCard containing a `<` is a vCard, not an element. What it does not mean is
 * "extract the text": the parser hands back the source between the tags
 * verbatim, and everything XML allows as packaging comes along. Open-Xchange
 * (mailbox.org) wraps the card in `<![CDATA[…]]>`, so the string starts
 * `<![CDATA[BEGIN:VCARD` and no vCard parser will touch it. Against a real
 * account that is an address book of 79 cards listing as empty.
 *
 * Splitting rather than stripping, because a CDATA section is not just
 * punctuation: **inside it, `&amp;` is five characters, not one.** A card whose
 * note came out of an HTML editor says `&amp;` and means it. So the decoder
 * runs on the segments *outside* the sections only, and what is inside is taken
 * as it stands.
 *
 * More than one section is ordinary, not exotic: `]]>` cannot appear inside
 * CDATA, so a server splits a card containing that sequence into
 * `…a]]]]><![CDATA[>b…` and expects the reader to join it back up.
 *
 * The `trim` belongs to the same idea. `trimValues: true` never reaches a stop
 * node (measured), so a server that indents its response hands over
 * `\n        BEGIN:VCARD…`, which fails to parse exactly as loudly and exactly
 * as silently. Leading whitespace before `BEGIN:` is packaging too.
 *
 * **Not covered: XML comments.** They also survive into the raw source
 * (measured), and no CardDAV server is known to write one inside
 * `address-data`. If a listing is ever empty against a server this function
 * already unwraps, that is the next thing to look at.
 */
function unwrapDocumentNode(
  value: string,
  decodeText: (text: string) => string
): string {
  let result = '';
  let index = 0;
  for (;;) {
    // `indexOf`, never a pattern: this runs on a document a server chose the
    // length of, and `test/linear-time.test.ts` holds the ceiling.
    const start = value.indexOf(CDATA_OPEN, index);
    if (start === -1) {
      result += decodeText(value.slice(index));
      break;
    }
    result += decodeText(value.slice(index, start));
    const body = start + CDATA_OPEN.length;
    const end = value.indexOf(CDATA_CLOSE, body);
    if (end === -1) {
      // Unterminated. The parser rejects the document before this point
      // (measured), so this is the second belt: take the rest as it stands
      // rather than decode something that announced itself as literal.
      result += value.slice(body);
      break;
    }
    result += value.slice(body, end);
    index = end + CDATA_CLOSE.length;
  }
  return result.trim();
}

function decode(value: string, lineEndings: LineEndingPolicy): string {
  return value.replace(
    /&(?:(amp|lt|gt|quot|apos)|#(\d+)|#[xX]([0-9a-fA-F]+));/g,
    (
      source: string,
      named: string | undefined,
      dec: string | undefined,
      hex: string | undefined,
      offset: number,
      full: string
    ) => {
      if (named !== undefined) {
        return (
          { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named] ?? source
        );
      }
      const code = Number.parseInt(
        dec ?? hex ?? '',
        dec !== undefined ? 10 : 16
      );
      if (!Number.isFinite(code)) return source;
      if (code > 0x10ffff) return source;
      // Surrogates are not characters; a reference to one is malformed.
      if (code >= 0xd800 && code <= 0xdfff) return source;
      if (code === 0x0a || code === 0x0d) {
        if (
          lineEndings === 'before-newline' &&
          full.charCodeAt(offset + source.length) === 0x0a
        ) {
          return String.fromCodePoint(code);
        }
        return source;
      }
      // C0 and C1, tab excepted. This is the injection guard described above.
      if (code < 0x20 && code !== 0x09) return source;
      if (code >= 0x7f && code <= 0x9f) return source;
      return String.fromCodePoint(code);
    }
  );
}

/**
 * Refuses any document that declares a DTD or entities.
 *
 * The parser below does not process entities, so there is no local expansion
 * exposure. This guard exists so that can never silently change with a parser
 * update, and because a legitimate CardDAV response simply never contains one.
 */
export function assertNoDoctype(xml: string, what: string): void {
  if (/<!(doctype|entity)\b/i.test(xml)) {
    throw new Error(
      `${what} returned XML containing a DOCTYPE or ENTITY declaration, ` +
        'which this server refuses to parse.'
    );
  }
}

/**
 * The parser, deliberately dumb.
 *
 * `removeNSPrefix` is the one option worth arguing about. Radicale answers with
 * a default namespace for DAV and a prefix for CardDAV
 * (`<multistatus xmlns="DAV:" xmlns:C="…">`), sabre/dav prefixes both in
 * lowercase (`<d:multistatus xmlns:card="…">`), and a third server may prefix
 * both in uppercase. Writing prefix-agnostic accessors by hand means checking
 * three spellings at every access, forever. Collapsing them costs the ability
 * to tell two namespaces apart when they share a local name — and across the
 * property set above there is no such pair.
 *
 * What keeps that safe is a rule rather than a check: **no security decision is
 * ever taken from a collapsed XML name.** The address book allowlist is keyed
 * on the resolved collection *path*, never on anything this parser produced by
 * name.
 *
 * `parseTagValue: false` because an ETag of `"00123"` must stay a string, and
 * `stopNodes` because `address-data` is a document in its own right that has no
 * business being interpreted as markup.
 *
 * The price of that last one is worth naming: a stop node is handed back as
 * **source**, not as text, so the parser's own conveniences skip it. Entities
 * arrive undecoded, CDATA sections arrive with their markers, and
 * `trimValues: true` does not reach it. {@link unwrapDocumentNode} is where
 * that is paid off, and the reason a card from mailbox.org used to vanish.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: true,
  trimValues: true,
  isArray: (name) =>
    ['response', 'propstat', 'href', 'privilege', 'address-data-type'].includes(
      name
    ),
  stopNodes: ['*.address-data'],
});

/** One `<D:response>` of a multistatus, reduced to what this server reads. */
export interface DavResponse {
  /** The response's own href, exactly as the server spelled it. */
  href: string;
  /** Properties from 2xx propstat blocks only. */
  props: Record<string, unknown>;
  /** The per-resource status, where the server sent one instead of propstats. */
  status?: string | undefined;
}

/**
 * Parses a `207 Multi-Status` document.
 *
 * Properties are taken from 2xx propstat blocks **only**. That is not tidiness:
 * a server answers a PROPFIND for a property the resource does not have with a
 * second propstat block carrying `404 Not Found` and the property name as an
 * empty element. Reading properties out of both blocks would turn "this address
 * book has no description" into "this address book's description is the empty
 * string" — verified against Radicale 3.8.0.0, which answers every PROPFIND
 * with exactly this two-block shape.
 */
export function parseMultiStatus(xml: string, what: string): DavResponse[] {
  assertNoDoctype(xml, what);
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    // fast-xml-parser refuses `__proto__`, `constructor` and `prototype` as
    // element names, which is the right outcome — but it says so by throwing,
    // and "did not return parseable XML" reads like a broken endpoint where
    // the truth is a server sending element names no DAV document contains.
    const reason = error instanceof Error ? error.message : '';
    if (/\[SECURITY\]/.test(reason)) {
      throw new Error(
        `${what} returned XML with an element name that is a JavaScript ` +
          'prototype key, which this server refuses to read.',
        { cause: error }
      );
    }
    throw new Error(`${what} did not return parseable XML.`, { cause: error });
  }
  const multistatus = doc.multistatus as { response?: unknown[] } | undefined;
  if (multistatus === undefined) {
    throw new Error(
      `${what} did not return a DAV multistatus document. ` +
        'CARDDAV_URL is probably not a CardDAV endpoint.'
    );
  }
  const responses = Array.isArray(multistatus.response)
    ? multistatus.response
    : [];
  return responses.flatMap((raw): DavResponse[] => {
    const entry = raw as {
      href?: unknown[];
      propstat?: unknown[];
      status?: unknown;
    };
    const href = decodeXmlText(String(firstOf(entry.href) ?? ''));
    // An href past the ceiling is not a link this server will ever address —
    // an id is bounded at 2048 characters, a collection path is shorter — so
    // the response is dropped rather than carried into every function that
    // takes the path apart. See `MAX_HREF_CHARS`.
    if (href.length > MAX_HREF_CHARS) return [];
    const props: Record<string, unknown> = {};
    for (const rawStat of entry.propstat ?? []) {
      const stat = rawStat as { prop?: unknown; status?: unknown };
      if (!isOkStatus(String(stat.status ?? ''))) continue;
      Object.assign(props, (stat.prop ?? {}) as Record<string, unknown>);
    }
    // `address-data` is a stop node, so it arrives as raw source with its
    // entities intact, and it is the one property read straight out of `props`
    // instead of through `textOf` — which is where every other value is
    // decoded. Without this line a contact called `Tom & Jerry` reaches the
    // model as `Tom &amp; Jerry`, and the vCard parser reads the escaped form
    // into the formatted name. The sister server shipped exactly that bug and
    // an audit round found it.
    //
    // Through `decodeAddressData` rather than `decodeXmlText`: this is the one
    // node whose content is a document in its own right, so it needs the two
    // things the parser skips for a stop node — its packaging taken off (CDATA
    // markers, indentation) and its line endings read the way the server that
    // encoded them meant them. See the docblock there.
    if (typeof props['address-data'] === 'string') {
      props['address-data'] = decodeAddressData(props['address-data']);
    }
    return [
      {
        href,
        props,
        status: entry.status === undefined ? undefined : String(entry.status),
      },
    ];
  });
}

/**
 * The longest `<D:href>` a multistatus response may carry and still be read.
 *
 * A href is a server-chosen string with no length of its own, and every
 * function that takes a path apart used to run on it unbounded. One response
 * with an 80 000-character segment cost two seconds in `resourceNameOf`; a
 * segment filling the 16 MiB multistatus ceiling cost hours, for one REPORT.
 * Those functions are linear now, and this is the ceiling in front of them:
 * 8 KiB is longer than any URL a real CardDAV server issues and longer than
 * any id this server accepts, so nothing a caller can name is lost.
 */
export const MAX_HREF_CHARS = 8 * 1024;

/** The longest element name `parseDavError` reports as a precondition. */
const MAX_PRECONDITION_CHARS = 64;

/** `HTTP/1.1 200 OK` → true; `HTTP/1.1 404 Not Found` → false. */
function isOkStatus(status: string): boolean {
  const match = /\s(\d{3})\s/.exec(` ${status} `);
  if (match?.[1] === undefined) return false;
  const code = Number(match[1]);
  return code >= 200 && code < 300;
}

function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Reads the hrefs out of a property whose value is one or more `<D:href>`.
 *
 * `current-user-principal` and `addressbook-home-set` both have this shape, and
 * both may legally carry several.
 */
export function hrefsOf(prop: unknown): string[] {
  if (prop === undefined || prop === null) return [];
  const href = (prop as { href?: unknown }).href;
  const list = Array.isArray(href) ? href : href === undefined ? [] : [href];
  return list
    .map((entry) => decodeXmlText(String(entry)).trim())
    .filter((entry) => entry.length > 0);
}

/** Whether a `resourcetype` value contains a given element, e.g. `addressbook`. */
export function resourceTypeHas(prop: unknown, name: string): boolean {
  if (prop === undefined || prop === null || typeof prop !== 'object') {
    return false;
  }
  return Object.hasOwn(prop as Record<string, unknown>, name);
}

/** One `content-type`/`version` pair from a `supported-address-data`. */
export interface AddressDataType {
  contentType: string;
  version: string;
}

/**
 * The formats a `supported-address-data` advertises.
 *
 * Absent means "the server did not say", which per RFC 6352 §6.2.2 means
 * `text/vcard; version=3.0` is supported — not that nothing is. The caller
 * distinguishes the two by getting an empty array here and treating it as
 * "3.0, and possibly more".
 */
export function supportedAddressData(prop: unknown): AddressDataType[] {
  if (prop === undefined || prop === null || typeof prop !== 'object') {
    return [];
  }
  const types = (prop as { 'address-data-type'?: unknown })[
    'address-data-type'
  ];
  const list = Array.isArray(types)
    ? types
    : types === undefined
      ? []
      : [types];
  return list
    .map((entry) => {
      const attrs = entry as Record<string, unknown>;
      return {
        contentType: String(attrs['@_content-type'] ?? '').toLowerCase(),
        version: String(attrs['@_version'] ?? ''),
      };
    })
    .filter(
      (entry) => entry.contentType.length > 0 && entry.version.length > 0
    );
}

/** The privilege element names in a `current-user-privilege-set`. */
export function privileges(prop: unknown): string[] {
  if (prop === undefined || prop === null || typeof prop !== 'object')
    return [];
  const list = (prop as { privilege?: unknown }).privilege;
  const entries = Array.isArray(list) ? list : list === undefined ? [] : [list];
  return entries.flatMap((entry) =>
    entry !== null && typeof entry === 'object'
      ? Object.keys(entry as Record<string, unknown>)
      : []
  );
}

/**
 * Reads a plain text property, decoding entities.
 *
 * An element the server sent as empty (`<D:displayname />`) parses to an empty
 * string or an empty object depending on the shape; both mean absent here.
 */
export function textOf(prop: unknown): string | undefined {
  if (prop === undefined || prop === null) return undefined;
  if (typeof prop === 'object') return undefined;
  const text = decodeXmlText(String(prop)).trim();
  return text.length > 0 ? text : undefined;
}

/** Reads a property whose value is a non-negative integer, e.g. `max-resource-size`. */
export function numberOf(prop: unknown): number | undefined {
  const text = textOf(prop);
  if (text === undefined) return undefined;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Request bodies
//
// Hand-built template strings rather than an XML builder, and that is a choice
// with reasons: the set of bodies is closed and small, the exact bytes are worth
// asserting against a captured request, and a builder would be a second code
// path that has to be proven never to emit a DOCTYPE and never to encode a value
// differently from the escaper above. The usual objection to string-built XML —
// injection — is answered by the variable surface being almost empty: property
// names come from a closed union, hrefs are origin-checked outputs of
// `resolveHref`, and a sync token is echoed back through `escapeXmlText`.
// Exactly one free-form value exists, and it is escaped.
// ---------------------------------------------------------------------------

const DECL = '<?xml version="1.0" encoding="utf-8"?>';

/** A PROPFIND asking for the named properties and nothing else. */
export function propfindBody(props: readonly PropName[]): string {
  const elements = props.map((name) => `    <${name}/>`).join('\n');
  return `${DECL}
<D:propfind ${NS}>
  <D:prop>
${elements}
  </D:prop>
</D:propfind>
`;
}

/**
 * vCard properties this server names in a filter or a partial retrieval.
 *
 * A closed union for the same reason `PropName` is one: these end up as
 * attribute values in a request body, and a caller-supplied string must never
 * reach one.
 */
export type VCardProp =
  | 'UID'
  | 'FN'
  | 'N'
  | 'NICKNAME'
  | 'EMAIL'
  | 'TEL'
  | 'ORG'
  | 'TITLE'
  | 'ROLE'
  | 'ADR'
  | 'NOTE'
  | 'CATEGORIES'
  | 'BDAY'
  | 'ANNIVERSARY'
  | 'URL'
  | 'IMPP'
  | 'REV'
  | 'VERSION'
  | 'KIND'
  | 'MEMBER'
  | 'X-ADDRESSBOOKSERVER-KIND'
  | 'X-ADDRESSBOOKSERVER-MEMBER';

/**
 * The properties a summary listing asks for.
 *
 * `list_contacts` retrieves these instead of the whole card, which is the
 * difference between a few hundred bytes per contact and a few hundred
 * kilobytes once inline photos are involved.
 *
 * **A partially retrieved card must never reach the write path.** RFC 6352
 * §10.4 lets a client name the properties it wants, and the answer then looks
 * exactly like a complete vCard while missing everything not asked for — so a
 * read-modify-write built on one would silently delete the caller's photo,
 * their addresses and every X-property their phone wrote. The structural
 * guarantee is that `write.ts` never takes a card from a listing: it issues its
 * own `GET` for the resource it is about to replace, every time. `shape.ts`
 * marks these entries `partial: true` so the invariant is visible rather than
 * merely true, and a test asserts the write path re-fetches.
 */
export const SUMMARY_PROPS: readonly VCardProp[] = [
  'UID',
  'FN',
  'N',
  'NICKNAME',
  'EMAIL',
  'TEL',
  'ORG',
  'TITLE',
  'CATEGORIES',
  'REV',
  'VERSION',
  'KIND',
  'X-ADDRESSBOOKSERVER-KIND',
];

/** The properties a group listing needs: the membership, and nothing heavy. */
export const GROUP_PROPS: readonly VCardProp[] = [
  'UID',
  'FN',
  'N',
  'NOTE',
  'REV',
  'VERSION',
  'KIND',
  'MEMBER',
  'X-ADDRESSBOOKSERVER-KIND',
  'X-ADDRESSBOOKSERVER-MEMBER',
];

/** Renders an `<C:address-data>`, whole or narrowed to named properties. */
function addressData(props?: readonly VCardProp[]): string {
  if (props === undefined) return '    <C:address-data/>';
  const names = props
    .map((name) => `      <C:prop name="${name}"/>`)
    .join('\n');
  return `    <C:address-data>\n${names}\n    </C:address-data>`;
}

/**
 * An `addressbook-query` REPORT over a whole collection.
 *
 * With no filter this is "every card in this address book", which is what
 * CardDAV offers in place of CalDAV's time range — there is no natural
 * narrowing dimension for contacts, so the levers are `props` (fetch less per
 * card) and the caller's `limit` (keep fewer).
 */
export function addressbookQueryBody(props?: readonly VCardProp[]): string {
  return `${DECL}
<C:addressbook-query ${NS}>
  <D:prop>
    <D:getetag/>
${addressData(props)}
  </D:prop>
  <C:filter/>
</C:addressbook-query>
`;
}

/** How a `text-match` compares its term. RFC 6352 §10.5.4. */
export type MatchType = 'contains' | 'equals' | 'starts-with' | 'ends-with';

/** One field of a search, with the term it is matched against. */
export interface PropFilter {
  field: VCardProp;
  term: string;
}

/**
 * An `addressbook-query` REPORT matching a term against several properties at
 * once.
 *
 * **One request, not one per field** — and that is a real difference from the
 * sister server rather than a shortcut. RFC 4791 combines sibling
 * `prop-filter`s with AND and offers no alternative, so `search_events` has to
 * issue one request per field and union the hrefs itself. RFC 6352 §10.5 gives
 * `<C:filter>` a `test` attribute that defaults to **`anyof`**, so the same
 * question is one round trip here.
 *
 * The `test="anyof"` is written out rather than left to the default. It is the
 * whole semantics of the call, a reader should not have to know the default to
 * see that this is an OR, and a server that got the default wrong would return
 * an intersection that looks like "no matches" instead of an error.
 */
export function addressbookSearchBody(
  filters: readonly PropFilter[],
  options: {
    matchType?: MatchType;
    collation?: string;
    props?: readonly VCardProp[];
  } = {}
): string {
  if (filters.length === 0) {
    throw new XmlValueError('internal: a search needs at least one field.');
  }
  const matchType = options.matchType ?? 'contains';
  const collation =
    options.collation === undefined
      ? ''
      : ` collation="${escapeXmlText(options.collation)}"`;
  const body = filters
    .map(
      ({ field, term }) =>
        `    <C:prop-filter name="${field}">\n` +
        `      <C:text-match${collation} match-type="${matchType}">` +
        `${escapeXmlText(term)}</C:text-match>\n` +
        `    </C:prop-filter>`
    )
    .join('\n');
  return `${DECL}
<C:addressbook-query ${NS}>
  <D:prop>
    <D:getetag/>
${addressData(options.props)}
  </D:prop>
  <C:filter test="anyof">
${body}
  </C:filter>
</C:addressbook-query>
`;
}

/**
 * An `addressbook-multiget` REPORT: several named resources in one round trip.
 *
 * The hrefs are outputs of `resolveHref`, so they are absolute URLs on the
 * configured origin and cannot carry anything a caller chose. They are escaped
 * regardless — the cost is nothing and the alternative is a rule that has to
 * keep being true.
 */
export function addressbookMultigetBody(
  hrefs: readonly string[],
  props?: readonly VCardProp[]
): string {
  if (hrefs.length === 0) {
    throw new XmlValueError('internal: a multiget needs at least one href.');
  }
  const list = hrefs
    .map((href) => `  <D:href>${escapeXmlText(href)}</D:href>`)
    .join('\n');
  return `${DECL}
<C:addressbook-multiget ${NS}>
  <D:prop>
    <D:getetag/>
${addressData(props)}
  </D:prop>
${list}
</C:addressbook-multiget>
`;
}

/**
 * A `sync-collection` REPORT: what changed since a token. RFC 6578.
 *
 * An absent token asks for the initial synchronisation, which returns every
 * card. That is a legitimate first call and also the expensive one, so the
 * caller only requests `getetag` here — the point of this report is the list of
 * what moved, not the content behind it, and `get_contact` fetches the rest.
 *
 * `<D:sync-level>1</D:sync-level>` is required; the token is echoed back
 * through the escaper because it is a server-chosen opaque string that has
 * round-tripped through a tool argument, which is the one path on which
 * something a caller wrote could arrive here.
 */
export function syncCollectionBody(syncToken?: string): string {
  const token =
    syncToken === undefined
      ? '  <D:sync-token/>'
      : `  <D:sync-token>${escapeXmlText(syncToken)}</D:sync-token>`;
  return `${DECL}
<D:sync-collection ${NS}>
${token}
  <D:sync-level>1</D:sync-level>
  <D:prop>
    <D:getetag/>
  </D:prop>
</D:sync-collection>
`;
}

/** Largest body {@link parseDavError} will look at. */
export const MAX_ERROR_DOCUMENT_CHARS = 64 * 1024;

/**
 * Reads a DAV error document, which is more useful than a generic error body.
 *
 * sabre/dav puts a human-readable sentence in `<s:message>`, and both servers
 * name a failed precondition as an element inside `<D:error>`
 * (`<C:no-uid-conflict/>`, `<D:need-privileges/>`). Returning the precondition
 * name lets the caller say what actually went wrong instead of quoting a status
 * code back at the reader.
 */
export function parseDavError(
  xml: string
): { precondition?: string; message?: string } | undefined {
  // A real DAV error document is a few hundred bytes. Anything larger is not
  // one, and it is the body a hostile server controls most completely — so
  // the size is checked before a byte of it is parsed, and the DOCTYPE lock
  // holds here exactly as it does on a multistatus. Not throwing: the caller
  // is already building an error, and "no precondition found" is the right
  // answer to a document that is not a precondition.
  if (xml.length > MAX_ERROR_DOCUMENT_CHARS) return undefined;
  if (!/<[a-z0-9]*:?error[\s>]/i.test(xml)) return undefined;
  try {
    assertNoDoctype(xml, 'the error document');
  } catch {
    return undefined;
  }
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const error = doc.error;
  if (error === undefined || error === null || typeof error !== 'object') {
    return undefined;
  }
  const entries = error as Record<string, unknown>;
  const message = textOf(entries.message);
  // The element name is the server's, of no fixed length — 5 000 characters
  // came through here as a "precondition" and reached the error text. A real
  // one (`no-uid-conflict`, `supported-address-data`) is a short token.
  const precondition = Object.keys(entries)
    .find(
      (key) => key !== 'message' && !key.startsWith('@_') && key !== '#text'
    )
    ?.slice(0, MAX_PRECONDITION_CHARS);
  if (precondition === undefined && message === undefined) return undefined;
  return {
    ...(precondition === undefined ? {} : { precondition }),
    ...(message === undefined ? {} : { message }),
  };
}
