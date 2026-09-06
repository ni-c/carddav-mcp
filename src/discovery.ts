import { CardDavApiError, type CardDavApi } from './api.js';
import {
  AddressBookRegistry,
  normalisePath,
  type AddressBookEntry,
} from './books.js';
import {
  missingConfigKeys,
  missingConfigMessage,
  type Config,
} from './config.js';
import { AllowlistError } from './errors.js';
import {
  hrefsOf,
  numberOf,
  privileges,
  resourceTypeHas,
  supportedAddressData,
  textOf,
  type PropName,
} from './dav-xml.js';

/**
 * Walking from a URL somebody typed to the address books behind it.
 *
 * Nothing else in this server has a discovery phase, and it earns its own
 * module because it is a state machine with several legitimate shapes rather
 * than one request. The three that actually occur in the wild:
 *
 * - `https://dav.example.net` — a server root. Principal, then home set, then
 *   the collections underneath.
 * - `https://example.net/dav.php/` — Baikal, where the CardDAV endpoint sits
 *   under a path and the well-known route is only present when the vhost was
 *   configured for it. Its absence is normal, not a fault.
 * - `https://dav.example.net/addressbooks/willi/contacts/` — a collection URL,
 *   pasted out of a client's settings. Which is what most people actually do,
 *   so it is detected first rather than treated as a mistake.
 */

const HOME_PROPS: readonly PropName[] = [
  'D:resourcetype',
  'D:current-user-principal',
  'C:addressbook-home-set',
];

const PRINCIPAL_PROPS: readonly PropName[] = ['C:addressbook-home-set'];

const COLLECTION_PROPS: readonly PropName[] = [
  'D:resourcetype',
  'D:displayname',
  'C:addressbook-description',
  'C:supported-address-data',
  'C:max-resource-size',
  'CS:getctag',
  'D:sync-token',
  'D:current-user-privilege-set',
];

/** How long an address book list is reused before it is fetched again. */
const BOOK_TTL_MS = 300_000;

/** What discovery established about the account, once per process. */
export interface Principal {
  /** Absolute URL of the principal, when one was found. */
  url: string | undefined;
  /** Absolute URLs of the address book home sets. */
  homes: readonly string[];
  /** Set when CARDDAV_URL turned out to be an address book collection itself. */
  singleBook: boolean;
  /** Anything worth telling the operator about how discovery went. */
  notes: readonly string[];
}

export class Discovery {
  private readonly api: CardDavApi;
  private readonly config: Config;
  private readonly allowlist: readonly string[];
  private principalPromise: Promise<Principal> | undefined;
  private books: { at: number; registry: AddressBookRegistry } | undefined;
  private inFlight: Promise<AddressBookRegistry> | undefined;
  private warnedUnmatched = false;

  constructor(api: CardDavApi, config: Config) {
    this.api = api;
    this.config = config;
    this.allowlist = config.addressBooks;
  }

  /**
   * Refuses to walk anywhere without a configuration.
   *
   * `api.send` already refuses, but {@link probe} deliberately swallows a
   * failure so that a wrong guess about where the endpoint is does not end the
   * walk — and that swallowed the setup message too. Discovery then carried on
   * with an empty base URL and died in `new URL('/.well-known/carddav', '')`
   * with **`Invalid URL`**, on precisely the path a registry or a sandbox
   * inspector takes. The server is required to start without credentials; the
   * first call is required to say what is missing.
   */
  private assertConfigured(): void {
    const missing = missingConfigKeys(this.config);
    if (missing.length > 0) throw new Error(missingConfigMessage(missing));
  }

  /**
   * The principal and its home sets, resolved once per process.
   *
   * Memoised as a promise rather than as a value so that four tool calls
   * arriving together produce one discovery instead of four. Nothing about a
   * principal changes without a reconfiguration, so there is no TTL.
   */
  async principal(): Promise<Principal> {
    this.principalPromise ??= this.discoverPrincipal();
    return this.principalPromise;
  }

  /**
   * The address book registry.
   *
   * Held for {@link BOOK_TTL_MS} because a book can be created in another
   * client mid-session, and refetching one Depth:1 PROPFIND is cheap next to
   * answering out of a stale list. `list_address_books` passes `force: true` —
   * being current is that tool's entire job.
   */
  async registry(force = false): Promise<AddressBookRegistry> {
    const cached = this.books;
    if (
      !force &&
      cached !== undefined &&
      Date.now() - cached.at < BOOK_TTL_MS
    ) {
      return cached.registry;
    }
    this.inFlight ??= this.discoverBooks().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /**
   * A PROPFIND that is allowed to come back with nothing.
   *
   * Each numbered step below is a *guess* about where the DAV endpoint is, and
   * a guess that turns out to be wrong must not end the walk. Pointing
   * CARDDAV_URL at `https://example.net` when Baikal serves DAV from
   * `/dav.php/` is the case: the origin answers a PROPFIND with its ordinary
   * HTML page, the DOCTYPE guard refuses it — correctly, that is not a DAV
   * document — and in the sister server the exception escaped before the
   * well-known route, which is *precisely* the route RFC 6764 defines for this
   * situation, had been tried. The result was a server that could not find an
   * endpoint it was one redirect away from, and an error message about XML.
   * Baikal found that on its first day in the suite.
   *
   * Only the parse and the status are softened. A network failure, a refused
   * connection or a 401 still throws, because those are not "the endpoint is
   * somewhere else" — they are the answer.
   */
  private async probe(
    url: string
  ): Promise<Awaited<ReturnType<CardDavApi['propfind']>>> {
    try {
      return await this.api.propfind(url, 0, HOME_PROPS);
    } catch (error) {
      if (error instanceof CardDavApiError) throw error;
      return [];
    }
  }

  private async discoverPrincipal(): Promise<Principal> {
    this.assertConfigured();
    const notes: string[] = [];
    const root = `${this.api.url}/`;

    // 1. Ask the configured URL about itself. This answers the collection case
    //    outright and, on most servers, hands over the principal in the same
    //    round trip.
    const first = await this.probe(root);
    const self = first[0];
    if (
      self !== undefined &&
      resourceTypeHas(self.props.resourcetype, 'addressbook')
    ) {
      return {
        url: undefined,
        homes: [],
        singleBook: true,
        notes: [
          'CARDDAV_URL is an address book collection, so this server sees ' +
            'exactly that one book. Point it at the server root to see all of ' +
            'them.',
        ],
      };
    }

    let principalHref = firstHref(self?.props['current-user-principal']);

    // 2. RFC 6764's well-known route, which is defined *as* a redirect. Only
    //    tried when the configured URL did not already answer.
    if (principalHref === undefined) {
      const probe = await this.api.probeWellKnown();
      if (probe.refusedOrigin !== undefined) {
        notes.push(
          `The well-known route redirected to ${probe.refusedOrigin}, which is ` +
            'not the configured server, so it was not followed. If that is ' +
            'the right address book host, set CARDDAV_URL to it.'
        );
      }
      if (probe.url !== undefined) {
        const viaWellKnown = await this.probe(probe.url);
        principalHref = firstHref(
          viaWellKnown[0]?.props['current-user-principal']
        );
      }
    }

    // 3. Some servers answer this property only at the origin root.
    if (principalHref === undefined) {
      const originRoot = `${this.api.origin}/`;
      if (originRoot !== root) {
        const viaOrigin = await this.probe(originRoot);
        principalHref = firstHref(
          viaOrigin[0]?.props['current-user-principal']
        );
      }
    }

    if (principalHref === undefined) {
      notes.push(
        'This server did not report a principal, so CARDDAV_URL is being ' +
          'treated as the address book home set directly.'
      );
      return {
        url: undefined,
        homes: [root],
        singleBook: false,
        notes,
      };
    }

    const principalUrl = this.api.resolveHref(principalHref, root);

    // 4. The home set.
    const onPrincipal = await this.api.propfind(
      principalUrl,
      0,
      PRINCIPAL_PROPS
    );
    const props = onPrincipal[0]?.props ?? {};
    const homes = hrefsOf(props['addressbook-home-set']).map((href) =>
      this.api.resolveHref(href, principalUrl)
    );

    if (homes.length === 0) {
      notes.push(
        'The principal named no address book home set, so CARDDAV_URL is ' +
          'being used as the home set.'
      );
    }

    return {
      url: principalUrl,
      homes: homes.length > 0 ? homes : [root],
      singleBook: false,
      notes,
    };
  }

  private async discoverBooks(): Promise<AddressBookRegistry> {
    const principal = await this.principal();
    const found: AddressBookEntry[] = [];

    if (principal.singleBook) {
      const url = `${this.api.url}/`;
      const responses = await this.api.propfind(url, 0, COLLECTION_PROPS);
      const entry = this.toEntry(responses[0], url);
      if (entry !== undefined) found.push(entry);
    } else {
      for (const home of principal.homes) {
        const responses = await this.api.propfind(home, 1, COLLECTION_PROPS);
        for (const response of responses) {
          const entry = this.toEntry(response, home);
          if (entry !== undefined) found.push(entry);
        }
      }
    }

    // Stable order, so two runs of the same listing agree.
    found.sort((left, right) => left.path.localeCompare(right.path));
    const registry = new AddressBookRegistry(dedupe(found), this.allowlist);

    // The allowlist is checked here because here is the first moment it can be:
    // its entries are matched against books that do not exist until this method
    // has run.
    //
    // An ambiguous entry is refused rather than resolved. Only a bare final
    // segment can be ambiguous, and `work` standing for two different
    // collections is not something to settle by picking one — either choice
    // silently grants access to a collection the operator may not have meant,
    // and the failure would be invisible because the server would carry on
    // working. Refusing costs a startup error; guessing costs a fence.
    const ambiguous = registry.ambiguous();
    if (ambiguous.length > 0) {
      throw new AllowlistError(
        `carddav-mcp: CARDDAV_ADDRESSBOOKS cannot be applied as written. ` +
          ambiguous
            .map(
              ({ entry, paths }) =>
                `"${entry}" matches ${paths.length} address books (${paths.join(', ')})`
            )
            .join('; ') +
          '. Name those address books by full path instead of by their last ' +
          'segment.'
      );
    }

    // An entry matching nothing is a warning, not an error: it is usually a
    // typo, but it is also what an address book that was deleted upstream looks
    // like, and refusing to start over a stale name would be worse than saying
    // so. Once per process — the registry is rebuilt whenever the cache
    // expires, and the same warning on a loop teaches people to ignore it.
    if (!this.warnedUnmatched) {
      const unmatched = registry.unmatched();
      if (unmatched.length > 0) {
        this.warnedUnmatched = true;
        console.error(
          `carddav-mcp: CARDDAV_ADDRESSBOOKS names ${unmatched.length} entr` +
            `${unmatched.length === 1 ? 'y' : 'ies'} matching no address book ` +
            `on this account: ${unmatched.join(', ')}. Check the spelling — an ` +
            `entry that matches nothing grants nothing.`
        );
      }
    }

    this.books = { at: Date.now(), registry };
    return registry;
  }

  /**
   * Turns one multistatus response into an address book, or into nothing.
   *
   * The filter is where the collections that are *not* address books get
   * dropped: the home collection itself, and a calendar on a server that hosts
   * both — which is the common case, since Radicale, Baikal and Nextcloud all
   * serve CalDAV and CardDAV from one principal.
   */
  private toEntry(
    response: { href: string; props: Record<string, unknown> } | undefined,
    relativeTo: string
  ): AddressBookEntry | undefined {
    if (response === undefined) return undefined;
    const type = response.props.resourcetype;
    if (!resourceTypeHas(type, 'addressbook')) return undefined;
    if (
      resourceTypeHas(type, 'calendar') ||
      resourceTypeHas(type, 'schedule-inbox') ||
      resourceTypeHas(type, 'schedule-outbox') ||
      resourceTypeHas(type, 'notification')
    ) {
      return undefined;
    }

    let url: string;
    try {
      url = this.api.resolveHref(response.href, relativeTo);
    } catch {
      // A cross-origin href in a listing is not worth failing the whole
      // discovery over; the book is simply not reachable from here.
      return undefined;
    }
    const path = normalisePath(new URL(url).pathname);
    const granted = privileges(response.props['current-user-privilege-set']);
    return {
      url: `${url.replace(/\/+$/, '')}/`,
      path,
      displayName: textOf(response.props.displayname),
      description: textOf(response.props['addressbook-description']),
      supportedTypes: supportedAddressData(
        response.props['supported-address-data']
      ),
      maxResourceSize: numberOf(response.props['max-resource-size']),
      ctag: textOf(response.props.getctag),
      syncToken: textOf(response.props['sync-token']),
      // Absent privileges mean the server did not say, which is not the same as
      // "no write" — assuming read-only there would refuse every write on a
      // server that simply does not report the property.
      readOnly:
        granted.length > 0 &&
        !granted.some((privilege) =>
          ['write', 'write-content', 'all', 'bind'].includes(privilege)
        ),
    };
  }
}

function firstHref(prop: unknown): string | undefined {
  return hrefsOf(prop)[0];
}

/**
 * One entry per path.
 *
 * Where a server reports the same collection twice with different privilege
 * sets, the *stricter* answer wins: `readOnly` is a guard on this side, and a
 * guard decided by document order is a guard the server chooses. A write to a
 * collection that is in fact writable is refused with a sentence; a write to
 * one that is not would have been refused by the server anyway.
 */
function dedupe(entries: readonly AddressBookEntry[]): AddressBookEntry[] {
  const byPath = new Map<string, AddressBookEntry>();
  for (const entry of entries) {
    const existing = byPath.get(entry.path);
    if (existing === undefined) {
      byPath.set(entry.path, entry);
    } else if (entry.readOnly && !existing.readOnly) {
      byPath.set(entry.path, { ...existing, readOnly: true });
    }
  }
  return [...byPath.values()];
}
