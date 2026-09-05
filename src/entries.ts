import { CardDavApiError, type CardDavApi } from './api.js';
import { stripInvisible } from './analyze.js';
import { resourceUrl, type AddressBookEntry } from './books.js';
import {
  addressbookQueryBody,
  addressbookSearchBody,
  textOf,
  type PropFilter,
  type VCardProp,
} from './dav-xml.js';
import { ToolInputError } from './errors.js';
import {
  parseVCard,
  readList,
  readText,
  readTyped,
  type ICAL,
} from './vcard.js';

/**
 * The read pipeline: query a collection, get cards back, shape them.
 *
 * Everything here works on whole `ResourceDocument`s — the card as the server
 * sent it, plus the two things needed to address and guard it. Shaping happens
 * one layer up, in `shape.ts`, so that the write path can reuse the loading
 * half without going anywhere near a projection.
 */

/** One card as the server returned it. */
export interface ResourceDocument {
  book: AddressBookEntry;
  resourceName: string;
  vcf: string;
  etag: string | undefined;
}

/**
 * The resource name inside a collection, from the href the server sent.
 *
 * Kept percent-encoded exactly as received: the name is appended to the
 * collection URL to reach the resource again, so decoding it here would produce
 * a URL that does not resolve.
 *
 * The href is a value the server chose, so it gets the same two checks every
 * other server-supplied link gets. `resolveHref` pins it to the configured
 * origin. The parent-directory check is the one that matters here: a REPORT is
 * issued against one collection, and a response naming a resource in a
 * different one would otherwise be filed under the address book that was asked
 * — so a card out of a collection the operator fenced off would be listed as
 * belonging to one they allowed, with an id that then reads a different
 * resource. Empty means "not from this collection, drop it".
 */
export function resourceNameOf(
  href: string,
  api: Pick<CardDavApi, 'resolveHref'>,
  book: Pick<AddressBookEntry, 'url' | 'path'>
): string {
  let resolved: URL;
  try {
    resolved = new URL(api.resolveHref(href, book.url));
  } catch {
    return '';
  }
  // A query or a fragment ends the path, so `/dav/work/a?b.vcf` has the
  // pathname `/dav/work/a` — it sits in the right collection and would have
  // been filed as the resource `a`, an id addressing something the href never
  // named. `resourceUrl` refuses these on the writing end; this is the same
  // refusal on the reading end, where the id is minted.
  if (resolved.search !== '' || resolved.hash !== '') return '';
  const path = resolved.pathname;
  // The same two conditions `resourceUrl` asserts, because the two functions
  // answer the same question from opposite ends: the name sits directly inside
  // the collection, and it is not the collection itself. An href equal to the
  // collection would otherwise file the collection's own name as a resource.
  const parent = path.replace(/[^/]*$/, '');
  if (parent !== book.path || path === book.path) return '';
  return path.slice(parent.length);
}

/** Runs a REPORT against one address book and collects the cards. */
async function queryBook(
  api: CardDavApi,
  book: AddressBookEntry,
  body: string
): Promise<ResourceDocument[]> {
  const responses = await api.report(book.url, 1, body);
  const documents: ResourceDocument[] = [];
  for (const response of responses) {
    const data = response.props['address-data'];
    if (typeof data !== 'string' || data.length === 0) continue;
    const name = resourceNameOf(response.href, api, book);
    if (name === '') continue;
    documents.push({
      book,
      resourceName: name,
      vcf: data,
      // Through `textOf` like every other property, so it is entity-decoded
      // and never carries what an attribute-shaped value could smuggle.
      etag: textOf(response.props.getetag),
    });
  }
  return documents;
}

/** Every card in the named address books, retrieving only `props` per card. */
export async function listCards(
  api: CardDavApi,
  books: readonly AddressBookEntry[],
  props?: readonly VCardProp[]
): Promise<ResourceDocument[]> {
  const body = addressbookQueryBody(props);
  const all: ResourceDocument[] = [];
  for (const book of books) {
    all.push(...(await queryBook(api, book, body)));
  }
  return all;
}

/** Which way a search result was arrived at, reported in the answer. */
export type SearchPath = 'server-filter' | 'client-filter';

export interface SearchOutcome {
  documents: ResourceDocument[];
  path: SearchPath;
  /** Set when a collation had to be named explicitly on the retry. */
  collation?: string;
  notes: string[];
}

/**
 * Runs a search across several address books.
 *
 * Three things happen here that are not obvious, and each of them exists
 * because a real server behaves differently from the specification's reading.
 *
 * **The server filter is not trusted to be exact.** Radicale implements
 * `addressbook-query` filtering only partially, and a server that returns too
 * much is indistinguishable from one that matched properly — the caller would
 * simply see wrong hits. So whatever comes back is checked again locally
 * against the same criteria. The cost is a comparison per card; the benefit is
 * that the answer means the same thing on every backend.
 *
 * **A collation the server refuses is retried once.** RFC 6352 lets a server
 * reject an unsupported collation with a `supported-collation` precondition.
 * Omitting the attribute takes the server's default, which both Radicale and
 * sabre/dav answer case-insensitively; where that is refused, `i;unicode-casemap`
 * — the CardDAV default — is named explicitly.
 *
 * **A server that cannot filter at all falls back to listing.** A 400 or a 501
 * on the query means this backend does not do `text-match`, which is a
 * legitimate if unhelpful position. Fetching the collection and filtering here
 * is slower and always correct, and the answer says which path was taken so
 * nobody has to guess why a search took four seconds.
 */
export async function searchCards(
  api: CardDavApi,
  books: readonly AddressBookEntry[],
  filters: readonly PropFilter[],
  props?: readonly VCardProp[]
): Promise<SearchOutcome> {
  const notes: string[] = [];
  let path: SearchPath = 'server-filter';
  let collation: string | undefined;
  const all: ResourceDocument[] = [];

  // Bound once. Under `exactOptionalPropertyTypes` an absent `props` has to be
  // an absent *key*, not a key holding `undefined`.
  const narrowing = props === undefined ? {} : { props };

  for (const book of books) {
    let documents: ResourceDocument[] | undefined;
    try {
      documents = await queryBook(
        api,
        book,
        addressbookSearchBody(filters, narrowing)
      );
    } catch (error) {
      if (
        error instanceof CardDavApiError &&
        error.precondition === 'supported-collation'
      ) {
        collation = 'i;unicode-casemap';
        documents = await queryBook(
          api,
          book,
          addressbookSearchBody(filters, { ...narrowing, collation })
        );
        notes.push(
          `${book.path} refused the default collation, so the search named ` +
            `${collation} explicitly.`
        );
      } else if (
        error instanceof CardDavApiError &&
        (error.status === 400 || error.status === 501)
      ) {
        path = 'client-filter';
        documents = await queryBook(api, book, addressbookQueryBody(props));
        notes.push(
          `${book.path} does not support server-side search, so every card in ` +
            'it was fetched and matched here instead.'
        );
      } else {
        throw error;
      }
    }
    all.push(...documents);
  }

  // The local pass, always. See the docblock: a server that returns too much
  // looks exactly like one that matched correctly.
  const matched = all.filter((document) => {
    let card: ICAL.Component;
    try {
      card = parseVCard(document.vcf, 'a card in the search result');
    } catch {
      // An unparseable card cannot be matched, and dropping it here is right:
      // it would fail again in shaping, and a search is not the place to
      // surface somebody's decade-old broken export.
      return false;
    }
    return filters.some(({ field, term }) => fieldContains(card, field, term));
  });

  if (matched.length < all.length) {
    notes.push(
      `${all.length - matched.length} card(s) the server returned did not ` +
        'actually match and were dropped here.'
    );
  }

  return {
    documents: matched,
    path,
    ...(collation === undefined ? {} : { collation }),
    notes,
  };
}

/**
 * Whether one vCard property contains a term, case-insensitively.
 *
 * Folded through `stripInvisible` on both sides. A card whose `FN` carries a
 * zero-width space between two letters is a card a plain `includes` will not
 * find, and hiding from a search is exactly what that character is there for.
 */
export function fieldContains(
  card: ICAL.Component,
  field: VCardProp,
  term: string
): boolean {
  const needle = stripInvisible(term).trim().toLowerCase();
  if (needle.length === 0) return false;
  const haystacks = valuesOf(card, field);
  return haystacks.some((value) =>
    stripInvisible(value).toLowerCase().includes(needle)
  );
}

/** Every string a field contributes, across all its occurrences. */
function valuesOf(card: ICAL.Component, field: VCardProp): string[] {
  const name = field.toLowerCase();
  const typed = readTyped(card, name).map((entry) => entry.value);
  if (typed.length > 0) return typed;
  const list = readList(card, name);
  if (list.length > 0) return list;
  const single = readText(card, name);
  return single === undefined ? [] : [single];
}

/**
 * Loads one card by id.
 *
 * `forWrite` raises the byte ceiling and is what the write path passes — see
 * `MAX_ROUNDTRIP_BYTES` in `api.ts` for why the two differ. It also means the
 * caller intends to PUT the result back, which is the invariant that keeps a
 * partially-retrieved listing entry out of a write: this is the only way a
 * write ever obtains a card, and it always fetches the whole thing.
 */
export async function loadCard(
  api: CardDavApi,
  book: AddressBookEntry,
  resourceName: string,
  forWrite = false
): Promise<{ card: ICAL.Component; vcf: string; etag: string | undefined }> {
  const url = resourceUrl(book, resourceName);
  const resource = await api.get(url, forWrite);
  const card = parseVCard(resource.vcf, 'the stored card');
  return { card, vcf: resource.vcf, etag: resource.etag };
}

/** Refuses a limit outside the configured bounds. */
export function boundedLimit(
  limit: number | undefined,
  fallback: number,
  max: number
): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new ToolInputError(
      `carddav-mcp: limit must be a whole number between 1 and ${max}.`
    );
  }
  return limit;
}
