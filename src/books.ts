import { quoted } from './analyze.js';
import { AddressBookNotAllowedError, ToolInputError } from './errors.js';
import type { AddressBookLookup } from './entity-id.js';
import type { AddressDataType } from './dav-xml.js';

/**
 * The address book registry, and every line of `CARDDAV_ADDRESSBOOKS`
 * enforcement.
 *
 * One file and one test file, because this is a security boundary. The rule the
 * whole server depends on is that there is **no single resolver a tool could
 * forget to call**: a tool either takes an id, in which case `parseEntityId`
 * performs the check while decoding, or it takes address books, in which case
 * it calls {@link AddressBookRegistry.resolveMany} — which, given nothing,
 * returns the *allowed* books and never the raw discovery result.
 *
 * `list_address_books` and `get_server_info` take neither and are guarded by
 * filtering what they print, with a count of what was withheld.
 */

/** One address book collection, as discovery found it. */
export interface AddressBookEntry {
  /** Absolute URL on the configured origin, with a trailing slash. */
  url: string;
  /** The URL's pathname — what the allowlist and every id are keyed on. */
  path: string;
  displayName: string | undefined;
  description: string | undefined;
  /**
   * Formats the collection accepts. Empty means the server did not say, which
   * per RFC 6352 §6.2.2 means `text/vcard; version=3.0` — not that nothing is
   * accepted.
   */
  supportedTypes: readonly AddressDataType[];
  /** `max-resource-size` in bytes, where the server advertises one. */
  maxResourceSize: number | undefined;
  ctag: string | undefined;
  /** The collection's current `sync-token`, where it supports RFC 6578. */
  syncToken: string | undefined;
  /** True when `current-user-privilege-set` grants no form of write. */
  readOnly: boolean;
}

/** Normalises a collection path for comparison: exactly one trailing slash. */
export function normalisePath(path: string): string {
  return `${stripTrailingSlashes(path)}/`;
}

/**
 * Removes every trailing `/`, by counting rather than with `/\/+$/`.
 *
 * That regex is quadratic on a run of slashes: it is retried from every
 * position of the run, and each attempt consumes the run to its end before `$`
 * fails on whatever follows. `new URL()` keeps repeated slashes in a pathname,
 * so a collection href of eighty thousand slashes and a letter reached here
 * from discovery and cost two seconds — on the thread that serves every
 * request. A loop walks the run once.
 */
export function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end -= 1;
  return path.slice(0, end);
}

/**
 * How an allowlist entry is matched against an address book.
 *
 * Three accepted spellings, in the order a person is likely to reach for them:
 * a full URL, an absolute path, or the collection's final path segment. What is
 * **not** accepted is a display name, and that is a decision rather than an
 * omission — on a shared address book the display name is chosen by whoever
 * shared it, it is not unique across a principal, and it changes without
 * notice. An allowlist keyed on a mutable, externally-controlled string is not
 * an allowlist.
 */
function matches(entry: string, book: AddressBookEntry): boolean {
  const candidate = entry.trim();
  if (candidate.length === 0) return false;

  // An entry written as a full URL has to agree about the **origin** as well as
  // the path. Comparing the pathname alone made a fence entry that is wrong
  // about the host fail *open*: `https://someone-else.example/dav/work/` granted
  // `/dav/work/` on the configured server. That is the wrong direction for an
  // allowlist, and it hides itself — the entry matches something, so the
  // `unmatched()` warning that would have surfaced the typo never fires.
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      if (url.origin !== new URL(book.url).origin) return false;
      return normalisePath(url.pathname) === book.path;
    } catch {
      return false;
    }
  }
  if (candidate.startsWith('/')) {
    return normalisePath(candidate) === book.path;
  }
  return finalSegment(book.path) === candidate.replace(/\/+$/, '');
}

/**
 * Ceiling on how many address books a registry holds.
 *
 * Every listing tool defaults to *all* permitted books, one REPORT per book,
 * thirty seconds allowed for each — so a server advertising two thousand
 * collections turned one `list_contacts` into a call that could run for hours.
 * No account has this many; the ones past the ceiling are counted and
 * reported by `list_address_books`, not silently dropped.
 */
export const MAX_ADDRESS_BOOKS = 256;

/** The longest allowlist entry that is ever quoted back. */
const MAX_QUOTED_ENTRY_CHARS = 200;

/**
 * An allowlist entry, made safe to print.
 *
 * `CARDDAV_ADDRESSBOOKS` sits one line below `CARDDAV_PASSWORD` in every
 * compose file, and the reaction to an entry that matches nothing used to be
 * to print it in full — to stderr, which is the MCP client's log, and into the
 * `list_address_books` answer, which is the model's context. A token pasted
 * into the wrong line matches nothing, so it was the one value guaranteed to
 * be printed. An entry is quoted only when it has the shape of something this
 * server would match — a path, a URL or a bare segment — and is otherwise
 * described by its length, the way `mcp-tool-allowlist` describes an entry
 * that is not a tool name.
 */
export function describeAllowlistEntry(entry: string): string {
  // A path or a URL announces itself with its first character and no
  // credential starts that way. A bare segment does not: a JWT, a hex key and
  // a base64 secret are all "letters, digits and a few punctuation marks",
  // so a bare word is quoted only while it is short enough to be a word —
  // `work`, `contacts`, `family` — and described by its length past that.
  const shaped =
    entry.length <= MAX_QUOTED_ENTRY_CHARS &&
    (/^\/[\x21-\x7e]*$/.test(entry) ||
      /^https?:\/\/[\x21-\x7e]*$/i.test(entry) ||
      (entry.length <= MAX_QUOTED_SEGMENT_CHARS &&
        /^[A-Za-z0-9_-]+$/.test(entry)));
  if (shaped) return `"${quoted(entry, MAX_QUOTED_ENTRY_CHARS)}"`;
  return `<an entry of ${entry.length} characters that is not shaped like an address book path, a short segment name or a URL — redacted in case it is a credential>`;
}

/** The longest bare segment that is quoted rather than described. */
const MAX_QUOTED_SEGMENT_CHARS = 24;

function finalSegment(path: string): string {
  const parts = path.split('/').filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? '';
}

/**
 * Builds the URL of a card inside an address book, and proves it stayed inside.
 *
 * The one place a collection URL and a resource name are joined. It exists
 * because checking the *name* is not the same as checking the *path*, and in
 * the sister server that difference was a real hole: `entity-id.ts` rejected a
 * literal `/` and a leading `.`, and both a percent-encoded dot segment and a
 * backslash walked straight past it —
 *
 * ```
 * new URL('https://h/dav/work/' + '%2E%2E')      -> https://h/dav/
 * new URL('https://h/dav/work/' + '\\..\\x.vcf')  -> https://h/dav/x.vcf
 * ```
 *
 * — because the WHATWG URL parser normalises percent-encoded dot segments and
 * treats a backslash as a separator, long after any string check has passed. A
 * forged id could therefore name an allowed address book, satisfy the
 * allowlist, and then address a card in a different one; `delete_contact` would
 * have removed another principal's card.
 *
 * So the assertion is on the resolved path rather than on the input: whatever
 * encoding trick comes next, the result still has to sit directly inside this
 * collection.
 *
 * And it is an assertion of *equality*, not only of containment. The parent
 * check alone lets a name like `a?x=1` through — inside the collection, so no
 * traversal, but the request it builds goes to `a` with a query string the id
 * never showed, and `a<CR><LF>b` reaches `ab` because the parser drops those
 * characters silently. An id is supposed to be one-to-one with the resource it
 * names, and that property would be established for the base64 layer and lost
 * at the URL layer. Requiring the resolved pathname to be the collection plus
 * the name exactly as given means the name has to already be in its canonical
 * percent-encoded form — which is precisely the form `resourceNameOf` hands
 * out — and a query, a fragment, a control character or raw non-ASCII all fail
 * to round-trip and are refused.
 */
export function resourceUrl(
  book: Pick<AddressBookEntry, 'url' | 'path'>,
  resourceName: string
): string {
  let url: URL;
  try {
    url = new URL(`${book.url}${resourceName}`);
  } catch {
    throw notInside();
  }
  // `lastIndexOf` rather than `/[^/]*$/`, for the reason on
  // `stripTrailingSlashes`: the name is bounded by the id schema, so this one
  // was never reachable at a size that mattered, but the same regex was and
  // one spelling is easier to keep honest than two.
  const parent = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
  if (
    parent !== book.path ||
    url.pathname === book.path ||
    url.pathname !== `${book.path}${resourceName}` ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw notInside();
  }
  return url.toString();
}

function notInside(): ToolInputError {
  return new ToolInputError(
    'carddav-mcp: that id does not name a card inside the address book it ' +
      'claims to be in. Ids come from the listing tools and are not meant ' +
      'to be composed by hand.'
  );
}

export class AddressBookRegistry implements AddressBookLookup {
  private readonly all: readonly AddressBookEntry[];
  private readonly permitted: readonly AddressBookEntry[];
  private readonly allowlist: readonly string[];
  /** Address books discovery found past `MAX_ADDRESS_BOOKS` and left out. */
  readonly truncated: number;

  constructor(
    all: readonly AddressBookEntry[],
    allowlist: readonly string[],
    truncated = 0
  ) {
    this.all = all;
    this.allowlist = allowlist;
    this.truncated = truncated;
    this.permitted =
      allowlist.length === 0
        ? all
        : all.filter((book) => allowlist.some((entry) => matches(entry, book)));
  }

  /** Every address book this server may touch. The only list a tool may print. */
  allowed(): readonly AddressBookEntry[] {
    return this.permitted;
  }

  /**
   * How many address books the allowlist is keeping out of sight.
   *
   * Reported by `list_address_books` rather than hidden, because a listing that
   * silently omits entries teaches the reader that the books do not exist — and
   * then a perfectly correct id from another source looks like a bug.
   */
  withheld(): number {
    return this.all.length - this.permitted.length;
  }

  allows(path: string): boolean {
    const wanted = normalisePath(path);
    return this.permitted.some((book) => book.path === wanted);
  }

  knows(path: string): boolean {
    const wanted = normalisePath(path);
    return this.all.some((book) => book.path === wanted);
  }

  /**
   * Allowlist entries that matched no address book.
   *
   * A typo here would otherwise fence the server off from everything in
   * silence, which is the failure mode a scope allowlist must not have. The
   * caller prints these on the startup line.
   */
  unmatched(): string[] {
    return this.allowlist.filter(
      (entry) => !this.all.some((book) => matches(entry, book))
    );
  }

  /**
   * Allowlist entries matching more than one address book.
   *
   * Only possible for a bare final segment, and it is a startup error rather
   * than a silent widening: `work` meaning two different collections is not
   * something to resolve by picking one.
   */
  ambiguous(): { entry: string; paths: string[] }[] {
    return this.allowlist
      .map((entry) => ({
        entry,
        paths: this.all
          .filter((book) => matches(entry, book))
          .map((book) => book.path),
      }))
      .filter((result) => result.paths.length > 1);
  }

  /**
   * Resolves one address book a caller named, refusing anything outside the
   * fence.
   *
   * A book the operator fenced off is answered with a refusal, not with "not
   * found": telling the two apart is what stops somebody hunting a typo in a
   * name that is spelled correctly and simply not permitted.
   */
  resolve(reference: string): AddressBookEntry {
    const wanted = reference.trim();
    if (wanted.length === 0) {
      throw new ToolInputError(
        'carddav-mcp: an address book was named as an empty string. Pass an id ' +
          'from list_address_books, or leave the argument out to use every ' +
          'address book.'
      );
    }
    const permitted = this.permitted.filter((book) => matches(wanted, book));
    if (permitted.length === 1) return permitted[0] as AddressBookEntry;
    if (permitted.length > 1) {
      throw new ToolInputError(
        `carddav-mcp: "${quoted(reference)}" matches ${permitted.length} ` +
          `address books (${permitted.map((book) => book.path).join(', ')}). ` +
          'Name it by its full path, which list_address_books prints.'
      );
    }
    if (this.all.some((book) => matches(wanted, book))) {
      throw new AddressBookNotAllowedError(
        `carddav-mcp: "${quoted(reference)}" is an address book this server was ` +
          'not given access to. CARDDAV_ADDRESSBOOKS names the ones it may ' +
          'touch; list_address_books shows which those are.'
      );
    }
    throw new ToolInputError(
      `carddav-mcp: no address book called "${quoted(reference)}". Call ` +
        'list_address_books to see what is available.'
    );
  }

  /**
   * Resolves the address books a tool should act on.
   *
   * With no argument this returns the **allowed** books — never `all`. That is
   * the whole reason this method exists rather than each tool reaching for a
   * list: the default case is the one most likely to be written without
   * thinking about the fence, so the fence is what the default returns.
   */
  resolveMany(references?: readonly string[]): readonly AddressBookEntry[] {
    if (references === undefined || references.length === 0) {
      if (this.permitted.length === 0) {
        throw new ToolInputError(
          this.all.length === 0
            ? 'carddav-mcp: the account has no address books, or none that this ' +
                'server could discover. get_server_info reports what it found.'
            : 'carddav-mcp: CARDDAV_ADDRESSBOOKS allows none of the address ' +
                'books this account has, so there is nothing to read.'
        );
      }
      return this.permitted;
    }
    const resolved = references.map((reference) => this.resolve(reference));
    // De-duplicate: two spellings of one book must not make it answer twice.
    const seen = new Set<string>();
    return resolved.filter((book) => {
      if (seen.has(book.path)) return false;
      seen.add(book.path);
      return true;
    });
  }

  /** The address book a decoded id points at. Assumes the id was checked. */
  byPath(path: string): AddressBookEntry | undefined {
    const wanted = normalisePath(path);
    return this.permitted.find((book) => book.path === wanted);
  }

  /**
   * Whether a collection accepts a vCard version.
   *
   * An empty `supportedTypes` means the server declared nothing, which RFC 6352
   * §6.2.2 reads as `text/vcard; version=3.0` — not as "nothing is accepted".
   * Both backends in the integration suite do declare the property (Radicale
   * 3.8 says 3.0, sabre/dav says 3.0 and 4.0), so this branch covers the
   * servers that do not rather than either of them.
   */
  accepts(book: AddressBookEntry, version: string): boolean {
    if (book.supportedTypes.length === 0) return version === '3.0';
    return book.supportedTypes.some((type) => type.version === version);
  }
}
