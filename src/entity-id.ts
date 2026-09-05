import { quoted } from './analyze.js';
import { AddressBookNotAllowedError, ToolInputError } from './errors.js';

/**
 * The addressing scheme, and the place the address book allowlist is enforced.
 *
 * ```
 * c1.<addressbook>.<resource>     one vCard — a contact or a group
 * ```
 *
 * Each part is base64url of a UTF-8 string, and `.` is outside the base64url
 * alphabet, so the whole thing is one unambiguous URL-safe token needing no
 * quoting anywhere.
 *
 * **There is one tag, not two, and that is a decision.** The sister server tags
 * an id with its component kind (`e1`/`t1`/`j1`) because a calendar collection
 * genuinely declares which components it accepts, so the kind is a property of
 * where the resource lives. A group is not: it is an ordinary vCard carrying
 * `KIND:group`, in the same collection, indistinguishable by path. Tagging it
 * would put a claim in the id that only the card's *content* can settle — and
 * an id that can be wrong about what it names is worse than one that says less.
 * So `get_group` reads the card and then says "that is a contact, use
 * get_contact", which is a true answer rather than a guess.
 *
 * Three properties are worth stating, because they are the reasons for the
 * shape rather than consequences of it:
 *
 * - **The origin is never in the id.** Only a path is, and the origin is
 *   recomposed from `CARDDAV_URL` on every decode. So the worst a forged or
 *   hand-edited id can do is name a path on the configured server; it can never
 *   redirect this server at another host.
 * - **It decodes without a round trip**, so it survives a restart and needs no
 *   server-side table — and therefore no cache lifetime, every choice of which
 *   would be wrong in one direction or the other.
 * - **{@link parseEntityId} takes the address book registry as a required
 *   argument**, and refuses an id naming a book outside it. There is no path
 *   from an id to a URL that does not pass through here, which is what makes
 *   "the allowlist is checked per tool" structural instead of a habit.
 */

/** The version tag that opens every id. */
const TAG = 'c1';

/** The minimum this module needs to know about the address book registry. */
export interface AddressBookLookup {
  /** Whether an address book path is inside `CARDDAV_ADDRESSBOOKS`. */
  allows(path: string): boolean;
  /** Whether the path names an address book that was discovered at all. */
  knows(path: string): boolean;
}

/** A decoded id. */
export interface EntityId {
  /** The address book collection's path, with its trailing slash. */
  bookPath: string;
  /** The card's name inside the collection, e.g. `a1b2c3.vcf`. */
  resourceName: string;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * Decodes one part, rejecting anything that is not exactly base64url of UTF-8.
 *
 * `Buffer.from(…, 'base64url')` is lenient: it ignores characters outside the
 * alphabet and accepts a truncated group, so two different ids can decode to
 * the same value. Re-encoding and comparing is what makes the mapping
 * one-to-one, which matters because these strings are compared against an
 * allowlist.
 */
function decode(part: string, id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) {
    throw badId(id);
  }
  const decoded = Buffer.from(part, 'base64url').toString('utf8');
  if (encode(decoded) !== part) throw badId(id);
  // A NUL in a decoded path is not a path; it is the classic attempt to end
  // a string early somewhere further down. Nothing this server issues can
  // contain one.
  if (decoded.includes('\0')) throw badId(id);
  return decoded;
}

function badId(id: string): ToolInputError {
  return new ToolInputError(
    `carddav-mcp: "${quoted(id)}" is not an id this server issued. Ids come ` +
      'from the listing tools — list_contacts, search_contacts, list_groups — ' +
      'and are not meant to be composed by hand.'
  );
}

/**
 * Whether a resource name contains a character the URL layer would not carry
 * faithfully: a C0 control or DEL, which the parser strips or encodes, or a
 * `?` or `#`, which end the path. Written as a code-point walk rather than a
 * regex so the file carries no control characters, escaped or otherwise.
 */
function hasUnaddressableCharacter(name: string): boolean {
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
    if (character === '?' || character === '#') return true;
  }
  return false;
}

/** The id of one card. */
export function buildEntityId(bookPath: string, resourceName: string): string {
  return `${TAG}.${encode(bookPath)}.${encode(resourceName)}`;
}

/**
 * Decodes an id, checking everything about it that can be checked here.
 */
export function parseEntityId(id: string, books: AddressBookLookup): EntityId {
  const parts = id.trim().split('.');
  if (parts.length !== 3) throw badId(id);

  const [tag, rawBook, rawResource] = parts as [string, string, string];
  if (tag !== TAG) throw badId(id);

  const bookPath = decode(rawBook, id);
  const resourceName = decode(rawResource, id);

  // An address book path is an absolute collection path. No dot segments,
  // because a path this server assembles never contains one and a path that
  // does was not assembled by this server.
  if (
    !bookPath.startsWith('/') ||
    bookPath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw badId(id);
  }

  // Every CardDAV server stores cards directly inside the collection, so a name
  // is one path segment.
  //
  // A literal `/` and a leading `.` are not enough, and believing they were is
  // what made this a real hole in the sister server: the WHATWG URL parser
  // normalises a percent-encoded dot segment and treats a backslash as a
  // separator, so `%2E%2E` and `\..\x` both survived this check and then walked
  // out of the collection at the moment the URL was built. Backslashes and
  // encoded dots are refused here, and `resourceUrl` asserts the *resolved*
  // path independently — a string check cannot anticipate the next encoding,
  // and a path check does not have to.
  //
  // `?`, `#` and control characters are refused for a different reason: they
  // do not leave the collection, they change what the request addresses
  // without the id saying so. `resourceUrl` catches those too, by requiring
  // the resolved path to equal the name; this check exists so the error names
  // the id rather than the URL.
  if (
    resourceName.length === 0 ||
    resourceName.includes('/') ||
    resourceName.includes('\\') ||
    resourceName.startsWith('.') ||
    /%2e/i.test(resourceName) ||
    hasUnaddressableCharacter(resourceName)
  ) {
    throw badId(id);
  }

  if (!books.allows(bookPath)) {
    throw new AddressBookNotAllowedError(
      books.knows(bookPath)
        ? 'carddav-mcp: that card is in an address book this server was not ' +
            'given access to. CARDDAV_ADDRESSBOOKS names the ones it may ' +
            'touch; list_address_books shows which those are.'
        : 'carddav-mcp: that card is in an address book this server cannot ' +
            'see. It may have been removed, or the id may be from a different ' +
            'configuration. Call list_address_books to see what is available.'
    );
  }

  return { bookPath, resourceName };
}
