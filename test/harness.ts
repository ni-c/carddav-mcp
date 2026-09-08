import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { expect, vi } from 'vitest';

import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';

/**
 * A CardDAV server small enough to keep in a variable.
 *
 * The unit suites need a backend that answers real multistatus XML, because the
 * parser, the discovery walk and the ETag handling are most of what there is to
 * get wrong. Stubbing `fetch` per test with hand-written responses would mean
 * writing that XML dozens of times and getting it subtly different each time;
 * this answers it once, from state, the way a server does.
 *
 * What it is **not** is a replacement for the integration suite. It agrees with
 * this server's understanding of CardDAV by construction, and the defects the
 * first integration run finds are always cases where that understanding was
 * wrong — no fake can catch those. It exists so the *other* thousand paths —
 * argument validation, shaping, budgets, refusals — can be tested without
 * Docker.
 */

export const ORIGIN = 'https://dav.example.net';
export const USER = 'tester';

/** One stored card. */
interface Stored {
  vcf: string;
  etag: string;
}

export interface FakeBook {
  name: string;
  displayName?: string;
  description?: string;
  /** vCard versions to advertise in `supported-address-data`. */
  versions?: string[];
  maxResourceSize?: number;
  readOnly?: boolean;
  resources?: Record<string, string>;
}

export interface FakeOptions {
  books?: FakeBook[];
  /** Emit sabre/dav's lowercase prefixes instead of Radicale's default namespace. */
  prefixes?: 'radicale' | 'sabre';
  /**
   * How the card is put inside `address-data`.
   *
   * The third server dialect, after Radicale's raw line endings and sabre/dav's
   * `&#13;`: Open-Xchange (mailbox.org) wraps the card in a CDATA section. All
   * three are legal XML and all three reach the reader as *source*, because
   * `address-data` is a stop node — which is what made this one an address book
   * of 79 cards listing as empty.
   */
  addressData?: 'escaped' | 'cdata';
  /** Refuse a text-match query without a collation, as some builds do. */
  refuseCollation?: boolean;
  /** Answer an addressbook-query with 501, as a server without filtering does. */
  refuseFiltering?: boolean;
  /**
   * Ignore the filter and return every card.
   *
   * This is the case the client-side re-filter exists for: a server that
   * matches only partially looks exactly like one that matched properly, so the
   * wrong hits arrive as answers rather than as errors.
   */
  looseFilter?: boolean;
  /** Do not implement RFC 6578, so `list_changes` has to say so. */
  refuseSync?: boolean;
  /**
   * Answer with this string as the `<D:sync-token>` instead of a generated one.
   *
   * The token is the one value in a `list_changes` answer that a DAV server
   * chooses freely, and that answer deliberately carries no untrusted marker.
   */
  syncToken?: string;
  /**
   * Answer a REPORT with hrefs pointing somewhere else than the collection
   * that was asked, the way a hostile or broken server can.
   */
  forgeHrefs?: (path: string, name: string) => string;
  /**
   * Report every book twice at the same href, the second copy read-only.
   *
   * Servers do this — a collection reachable through two hrefs, or a shared one
   * listed by both its own path and the sharee's. Which copy wins must not be
   * decided by document order.
   */
  duplicateReadOnly?: boolean;
  /**
   * The `DAV:` response header, verbatim.
   *
   * A response header is a string the far end chose, and `get_server_info`
   * reports this one in the server's own voice rather than as untrusted
   * content — so what a hostile value does to it is a test, not a hypothetical.
   */
  dav?: string;
  /** Issue weak ETags (`W/"…"`), which cannot guard a write. */
  weakEtags?: boolean;
  /** Issue ETags of this shape instead of `"etag-N"`; `%d` is the counter. */
  etagShape?: string;
  /** Answer every guarded PUT and DELETE with 412, as after a concurrent edit. */
  staleOnWrite?: boolean;
  /**
   * Answer a request with this status (and body) instead of handling it.
   * Called for every request; return `undefined` to let the fake proceed.
   */
  failWhen?: (
    method: string,
    url: string,
    index: number
  ) =>
    | { status: number; body?: string; headers?: Record<string, string> }
    | undefined;
  /** The href the principal PROPFIND answers with, instead of `/tester/`. */
  principalHref?: string;
  /** Extra `<D:response>` hrefs listed as children of the home, verbatim. */
  extraHomeChildren?: string[];
}

export class FakeCardDav {
  readonly books = new Map<
    string,
    { entry: FakeBook; resources: Map<string, Stored> }
  >();
  /**
   * Every request, with its headers. The headers are what a write guard *is*:
   * a test that only looks at the URL of a PUT cannot tell a guarded write from
   * an unguarded one, and the fake used to accept both.
   */
  readonly requests: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }[] = [];
  private sequence = 0;
  private syncCounter = 0;

  /** Requests still to be answered 503 before the fake behaves. */
  failNext = 0;
  private readonly options: FakeOptions;

  constructor(options: FakeOptions = {}) {
    this.options = options;
    for (const book of options.books ?? [
      { name: 'work', displayName: 'Work' },
      { name: 'private', displayName: 'Private' },
    ]) {
      const resources = new Map<string, Stored>();
      for (const [name, vcf] of Object.entries(book.resources ?? {})) {
        resources.set(name, { vcf, etag: this.nextEtag() });
      }
      this.books.set(`/${USER}/${book.name}/`, { entry: book, resources });
    }
  }

  private nextEtag(): string {
    this.sequence += 1;
    const shape = this.options.etagShape ?? '"etag-%d"';
    const strong = shape.replace('%d', String(this.sequence));
    return this.options.weakEtags === true ? `W/${strong}` : strong;
  }

  /** Puts a card in a book without going through the server under test. */
  seed(book: string, name: string, vcf: string): void {
    const store = this.books.get(`/${USER}/${book}/`);
    if (store === undefined) throw new Error(`no such book: ${book}`);
    store.resources.set(name, { vcf, etag: this.nextEtag() });
  }

  /** What is actually stored, for asserting an effect rather than an answer. */
  stored(book: string, name: string): string | undefined {
    return this.books.get(`/${USER}/${book}/`)?.resources.get(name)?.vcf;
  }

  names(book: string): string[] {
    const store = this.books.get(`/${USER}/${book}/`);
    return store === undefined ? [] : [...store.resources.keys()];
  }

  install(): void {
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) =>
      this.handle(String(input), init ?? {})
    );
  }

  private tag(local: string): string {
    return this.options.prefixes === 'sabre'
      ? local.replace(/^D:/, 'd:').replace(/^C:/, 'card:')
      : local.replace(/^D:/, '');
  }

  private card(local: string): string {
    return this.options.prefixes === 'sabre' ? `card:${local}` : `C:${local}`;
  }

  private envelope(inner: string, extra = ''): string {
    const attrs =
      this.options.prefixes === 'sabre'
        ? 'xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/"'
        : 'xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/"';
    const open = this.tag('D:multistatus');
    return `<?xml version="1.0" encoding="utf-8"?>\n<${open} ${attrs}>${inner}${extra}</${open}>`;
  }

  private response(href: string, ok: string, notFound = ''): string {
    const r = this.tag('D:response');
    const h = this.tag('D:href');
    const ps = this.tag('D:propstat');
    const pr = this.tag('D:prop');
    const st = this.tag('D:status');
    const missing =
      notFound === ''
        ? ''
        : `<${ps}><${pr}>${notFound}</${pr}><${st}>HTTP/1.1 404 Not Found</${st}></${ps}>`;
    return (
      `<${r}><${h}>${href}</${h}>` +
      `<${ps}><${pr}>${ok}</${pr}><${st}>HTTP/1.1 200 OK</${st}></${ps}>` +
      `${missing}</${r}>`
    );
  }

  private reply(
    status: number,
    body = '',
    headers: Record<string, string> = {}
  ): Response {
    // 204/205/304 are null-body statuses: `new Response('')` throws for them,
    // and an empty string is not null.
    const payload = [204, 205, 304].includes(status) ? null : body;
    return new Response(payload, {
      status,
      headers: {
        'content-type': body.startsWith('<?xml')
          ? 'application/xml; charset=utf-8'
          : 'text/plain',
        ...headers,
      },
    });
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? init.body : undefined;
    const path = new URL(url).pathname;
    const headers = { ...((init.headers ?? {}) as Record<string, string>) };
    this.requests.push({
      method,
      url,
      headers,
      ...(body === undefined ? {} : { body }),
    });

    if (new URL(url).origin !== ORIGIN) {
      throw new Error(`the fake was asked for ${url}, which is another origin`);
    }

    const scripted = this.options.failWhen?.(
      method,
      url,
      this.requests.length - 1
    );
    if (scripted !== undefined) {
      return this.reply(scripted.status, scripted.body ?? '', scripted.headers);
    }

    // A transient outage: the first `failNext` requests answer 503, everything
    // after them succeeds. What a DAV server restarting or a proxy having a bad
    // ten seconds looks like from here.
    if (this.failNext > 0) {
      this.failNext -= 1;
      return this.reply(503, 'temporarily unavailable');
    }

    if (method === 'OPTIONS') {
      return this.reply(200, '', {
        dav: this.options.dav ?? '1, 2, 3, addressbook',
        allow: 'GET, PUT, DELETE, PROPFIND, REPORT, OPTIONS',
      });
    }
    if (method === 'PROPFIND') return this.propfind(path, init, body ?? '');
    if (method === 'REPORT') return this.report(path, body ?? '');
    if (method === 'GET') return this.get(path);
    if (method === 'PUT') return this.put(path, init, body ?? '');
    if (method === 'DELETE') return this.del(path, init);
    return this.reply(405, 'method not allowed');
  }

  private propfind(path: string, init: RequestInit, body: string): Response {
    const depth = String(
      (init.headers as Record<string, string> | undefined)?.Depth ?? '0'
    );

    if (path === '/.well-known/carddav') {
      return this.reply(301, '', { location: '/' });
    }
    if (path === '/' && body.includes('current-user-principal')) {
      const cup = this.tag('D:current-user-principal');
      const h = this.tag('D:href');
      const principal = this.options.principalHref ?? `/${USER}/`;
      return this.reply(
        207,
        this.envelope(
          this.response('/', `<${cup}><${h}>${principal}</${h}></${cup}>`)
        )
      );
    }
    if (
      this.options.principalHref !== undefined &&
      path === new URL(this.options.principalHref, ORIGIN).pathname &&
      body.includes('addressbook-home-set')
    ) {
      // A hostile principal href still has to lead somewhere, or discovery
      // falls back to the root and the hostile string never reaches a result.
      const home = this.card('addressbook-home-set');
      const h = this.tag('D:href');
      return this.reply(
        207,
        this.envelope(
          this.response(path, `<${home}><${h}>/${USER}/</${h}></${home}>`)
        )
      );
    }
    if (path === `/${USER}/` && body.includes('addressbook-home-set')) {
      const home = this.card('addressbook-home-set');
      const h = this.tag('D:href');
      return this.reply(
        207,
        this.envelope(
          this.response(
            `/${USER}/`,
            `<${home}><${h}>/${USER}/</${h}></${home}>`
          )
        )
      );
    }
    if (path === `/${USER}/` && depth === '1') {
      const parts = [
        this.response(
          `/${USER}/`,
          `<${this.tag('D:resourcetype')}><${this.tag('D:collection')}/></${this.tag('D:resourcetype')}>`
        ),
      ];
      for (const [bookPath, store] of this.books) {
        parts.push(this.bookResponse(bookPath, store.entry));
        if (this.options.duplicateReadOnly === true) {
          parts.push(
            this.bookResponse(bookPath, { ...store.entry, readOnly: true })
          );
        }
      }
      for (const href of this.options.extraHomeChildren ?? []) {
        parts.push(this.bookResponse(href, { name: 'extra' }));
      }
      return this.reply(207, this.envelope(parts.join('')));
    }
    if (this.books.has(path) && depth === '0') {
      const store = this.books.get(path);
      if (store !== undefined) {
        return this.reply(
          207,
          this.envelope(this.bookResponse(path, store.entry))
        );
      }
    }
    return this.reply(404, 'not found');
  }

  private bookResponse(path: string, entry: FakeBook): string {
    const rt = this.tag('D:resourcetype');
    const coll = this.tag('D:collection');
    const ab = this.card('addressbook');
    const dn = this.tag('D:displayname');
    const desc = this.card('addressbook-description');
    const sad = this.card('supported-address-data');
    const adt = this.card('address-data-type');
    const mrs = this.card('max-resource-size');
    const ctag =
      this.options.prefixes === 'sabre' ? 'cs:getctag' : 'CS:getctag';
    const syncTag = this.tag('D:sync-token');
    const privset = this.tag('D:current-user-privilege-set');
    const priv = this.tag('D:privilege');
    const privileges =
      entry.readOnly === true
        ? `<${priv}><${this.tag('D:read')}/></${priv}>`
        : `<${priv}><${this.tag('D:read')}/></${priv}><${priv}><${this.tag('D:write')}/></${priv}>`;
    const versions = entry.versions ?? [];
    const types =
      versions.length === 0
        ? ''
        : `<${sad}>${versions
            .map(
              (version) =>
                `<${adt} content-type="text/vcard" version="${version}"/>`
            )
            .join('')}</${sad}>`;
    return this.response(
      path,
      `<${rt}><${coll}/><${ab}/></${rt}>` +
        `<${dn}>${escapeXml(entry.displayName ?? entry.name)}</${dn}>` +
        (entry.description === undefined
          ? ''
          : `<${desc}>${escapeXml(entry.description)}</${desc}>`) +
        types +
        (entry.maxResourceSize === undefined
          ? ''
          : `<${mrs}>${entry.maxResourceSize}</${mrs}>`) +
        `<${ctag}>ctag-${this.sequence}</${ctag}>` +
        (this.options.refuseSync === true
          ? ''
          : `<${syncTag}>sync-${this.syncCounter}</${syncTag}>`) +
        `<${privset}>${privileges}</${privset}>`
    );
  }

  private report(path: string, body: string): Response {
    const store = this.books.get(path);
    if (store === undefined) return this.reply(404, 'not found');

    if (body.includes('sync-collection')) return this.syncReport(path, store);
    if (body.includes('addressbook-multiget')) {
      return this.multiget(path, store, body);
    }

    if (this.options.refuseFiltering === true && body.includes('prop-filter')) {
      return this.reply(501, 'filtering is not implemented');
    }
    if (
      this.options.refuseCollation === true &&
      body.includes('text-match') &&
      !body.includes('collation=')
    ) {
      return this.reply(
        403,
        '<?xml version="1.0"?><D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><C:supported-collation/></D:error>'
      );
    }

    // The filter, read out of the body the way a server would. Sibling
    // prop-filters are combined with OR, which is CardDAV's default and the
    // whole reason a multi-field search is one request here.
    const filters = [
      ...body.matchAll(
        /<C:prop-filter name="([A-Z-]+)">\s*<C:text-match[^>]*>([\s\S]*?)<\/C:text-match>/g
      ),
    ].map((match) => ({
      field: match[1] ?? '',
      term: unescapeXml(match[2] ?? '').toLowerCase(),
    }));

    const wanted = propsAsked(body);
    const parts: string[] = [];
    for (const [name, resource] of store.resources) {
      if (
        filters.length > 0 &&
        this.options.looseFilter !== true &&
        !filters.some(({ field, term }) =>
          propertyValues(resource.vcf, field).some((value) =>
            value.toLowerCase().includes(term)
          )
        )
      ) {
        continue;
      }
      parts.push(this.cardResponse(path, name, resource, wanted));
    }
    return this.reply(207, this.envelope(parts.join('')));
  }

  private multiget(
    path: string,
    store: { resources: Map<string, Stored> },
    body: string
  ): Response {
    const wanted = propsAsked(body);
    const hrefs = [...body.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map(
      (match) => unescapeXml(match[1] ?? '')
    );
    const parts: string[] = [];
    for (const href of hrefs) {
      const name = new URL(href, ORIGIN).pathname.slice(path.length);
      const resource = store.resources.get(name);
      if (resource === undefined) {
        parts.push(
          `<${this.tag('D:response')}><${this.tag('D:href')}>${escapeXml(href)}</${this.tag('D:href')}>` +
            `<${this.tag('D:status')}>HTTP/1.1 404 Not Found</${this.tag('D:status')}></${this.tag('D:response')}>`
        );
        continue;
      }
      parts.push(this.cardResponse(path, name, resource, wanted));
    }
    return this.reply(207, this.envelope(parts.join('')));
  }

  private syncReport(
    path: string,
    store: { resources: Map<string, Stored> }
  ): Response {
    if (this.options.refuseSync === true) {
      return this.reply(
        403,
        '<?xml version="1.0"?><D:error xmlns:D="DAV:"><D:supported-report/></D:error>'
      );
    }
    this.syncCounter += 1;
    const etag = this.tag('D:getetag');
    const parts = [...store.resources].map(([name, resource]) =>
      this.response(`${path}${name}`, `<${etag}>${resource.etag}</${etag}>`)
    );
    const token = this.tag('D:sync-token');
    const value = this.options.syncToken ?? `sync-${this.syncCounter}`;
    return this.reply(
      207,
      this.envelope(parts.join(''), `<${token}>${value}</${token}>`)
    );
  }

  /**
   * One card in a REPORT answer, honouring a partial `address-data` request.
   *
   * Honoured rather than ignored, because "the server sent back only what was
   * asked for" is exactly the condition the `partial` marker and the
   * re-fetch-before-write rule exist for. A fake that always returned whole
   * cards would make both of them untestable.
   */
  private cardResponse(
    path: string,
    name: string,
    resource: Stored,
    wanted: string[] | undefined
  ): string {
    const etag = this.tag('D:getetag');
    const data = this.card('address-data');
    const vcf =
      wanted === undefined ? resource.vcf : narrow(resource.vcf, wanted);
    const body =
      this.options.addressData === 'cdata' ? wrapCdata(vcf) : escapeXml(vcf);
    return this.response(
      this.options.forgeHrefs?.(path, name) ?? `${path}${name}`,
      `<${etag}>${resource.etag}</${etag}><${data}>${body}</${data}>`
    );
  }

  private find(
    path: string
  ): { store: Map<string, Stored>; name: string } | undefined {
    for (const [bookPath, store] of this.books) {
      if (path.startsWith(bookPath)) {
        return { store: store.resources, name: path.slice(bookPath.length) };
      }
    }
    return undefined;
  }

  private get(path: string): Response {
    const found = this.find(path);
    const resource = found?.store.get(found.name);
    if (resource === undefined) return this.reply(404, 'not found');
    return this.reply(200, resource.vcf, {
      etag: resource.etag,
      'content-type': 'text/vcard; charset=utf-8',
    });
  }

  private put(path: string, init: RequestInit, body: string): Response {
    const found = this.find(path);
    if (found === undefined) return this.reply(409, 'no such collection');
    const headers = (init.headers ?? {}) as Record<string, string>;
    const existing = found.store.get(found.name);

    // A PUT with neither guard is one this server never sends, and a fake
    // that accepted it would keep every write test green through a regression
    // that dropped the guard. 428 Precondition Required is what RFC 6585 says.
    if (
      headers['If-None-Match'] === undefined &&
      headers['If-Match'] === undefined
    ) {
      return this.reply(428, 'a PUT without If-Match or If-None-Match');
    }
    if (headers['If-None-Match'] === '*' && existing !== undefined) {
      return this.reply(412, 'exists');
    }
    if (headers['If-Match'] !== undefined) {
      if (existing === undefined) return this.reply(404, 'not found');
      if (this.options.staleOnWrite === true) return this.reply(412, 'stale');
      if (headers['If-Match'] !== existing.etag) {
        return this.reply(412, 'stale');
      }
    }
    const etag = this.nextEtag();
    found.store.set(found.name, { vcf: body, etag });
    return this.reply(existing === undefined ? 201 : 204, '', { etag });
  }

  private del(path: string, init: RequestInit): Response {
    const found = this.find(path);
    const existing = found?.store.get(found.name);
    if (found === undefined || existing === undefined) {
      return this.reply(404, 'not found');
    }
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (headers['If-Match'] === undefined) {
      return this.reply(428, 'a DELETE without If-Match');
    }
    if (
      this.options.staleOnWrite === true ||
      headers['If-Match'] !== existing.etag
    ) {
      return this.reply(412, 'stale');
    }
    found.store.delete(found.name);
    return this.reply(204);
  }
}

/** The property names an `address-data` element asked for, or undefined. */
function propsAsked(body: string): string[] | undefined {
  if (!/<C:address-data>/.test(body)) return undefined;
  return [...body.matchAll(/<C:prop name="([A-Z0-9-]+)"\/>/gi)].map(
    (match) => match[1] ?? ''
  );
}

/** Keeps only the named properties of a card, as a partial retrieval does. */
function narrow(vcf: string, wanted: readonly string[]): string {
  const keep = new Set(wanted.map((name) => name.toUpperCase()));
  keep.add('BEGIN');
  keep.add('END');
  keep.add('VERSION');
  return vcf
    .split(/\r?\n/)
    .filter((line) => {
      const name = /^([A-Za-z0-9-]+)[;:]/.exec(line)?.[1]?.toUpperCase();
      return name !== undefined && keep.has(name);
    })
    .join('\r\n')
    .concat('\r\n');
}

/** Every value a vCard property has, for the fake's own filtering. */
function propertyValues(vcf: string, field: string): string[] {
  const name = field.toUpperCase();
  return vcf
    .split(/\r?\n/)
    .filter((line) => {
      const found = /^([A-Za-z0-9-]+)[;:]/.exec(line)?.[1]?.toUpperCase();
      return found === name;
    })
    .map((line) => line.slice(line.indexOf(':') + 1));
}

/**
 * A CDATA section, split the way a server has to split one.
 *
 * `]]>` cannot appear inside a section, so a card containing that sequence ends
 * the section and opens another around it. Writing it correctly here is what
 * makes the reader's joining rule testable rather than assumed.
 */
function wrapCdata(value: string): string {
  return `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** A complete configuration, overridable field by field. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: ORIGIN,
    username: USER,
    password: 'not-a-secret',
    token: undefined,
    addressBooks: [],
    maxEntries: 100,
    insecureTls: false,
    readOnly: false,
    elicitation: true,
    allowTools: undefined,
    denyTools: undefined,
    ...overrides,
  };
}

export interface Connected {
  client: Client;
  /** Every dialog the server put in front of the user. */
  prompts: string[];
  close(): Promise<void>;
}

/**
 * Links a client to a server over an in-memory transport.
 *
 * `elicit` decides whether the client declares the capability at all, which is
 * what makes a guarded tool choose between the dialog and the two-call token.
 * Both have to be exercised: a server that quietly stopped asking would keep
 * every token test green.
 */
export async function connect(
  config: Partial<Config> = {},
  elicit?: 'accept' | 'decline' | 'cancel'
): Promise<Connected> {
  const server = createServer(testConfig(config));
  const prompts: string[] = [];
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    elicit === undefined ? {} : { capabilities: { elicitation: {} } }
  );

  if (elicit !== undefined) {
    client.setRequestHandler('elicitation/create', (request) => {
      const params = request.params as { message?: string };
      prompts.push(params.message ?? '');
      if (elicit === 'cancel') return { action: 'cancel' };
      if (elicit === 'decline') return { action: 'decline' };
      return { action: 'accept', content: { confirm: true } };
    });
  }

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    client,
    prompts,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The text of every text block of a tool result. */
export function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] })
    .content;
  return (content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

/**
 * The structured half of a tool result, checked against the text block.
 *
 * Comparing the two channels here turns every assertion in every suite into a
 * check that they agree — hundreds of them, for one edit. Where a tool fences
 * its text (`get_contact`), the JSON is the last text block.
 */
export function dataOf(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  expect(structured, 'result carried no structuredContent').toBeDefined();
  const content = (result as { content?: { type: string; text?: string }[] })
    .content;
  const blocks = (content ?? []).filter((part) => part.type === 'text');
  const last = blocks[blocks.length - 1]?.text ?? '';
  expect(
    JSON.parse(last),
    'the JSON text block and structuredContent disagree'
  ).toEqual(structured);
  return structured as Record<string, unknown>;
}

/**
 * The structured half of the one result whose channels differ on purpose.
 *
 * `export_contacts` carries the stored bytes in `structuredContent` and a
 * defused rendering in the text block — see `exportResult`. `dataOf` would
 * report the two as disagreeing, which is the point of that tool, so the
 * export suites read the structured half directly and assert on the text
 * block separately.
 */
export function exportOf(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  expect(structured, 'result carried no structuredContent').toBeDefined();
  expect(textOf(result)).toContain('byte-exact export is in structuredContent');
  return structured as Record<string, unknown>;
}

/** Calls a tool and returns the raw result. */
export async function call(
  connected: Connected,
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  return connected.client.callTool({ name, arguments: args });
}

/** Drives both halves of the two-call token for a guarded tool. */
export async function confirmed(
  connected: Connected,
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const first = await call(connected, name, args);
  const token = /confirm_token="([0-9a-f]+)"/.exec(textOf(first))?.[1];
  expect(token, `no confirm_token in the first ${name} result`).toBeDefined();
  return call(connected, name, { ...args, confirm_token: token });
}

/** A minimal but complete vCard, for seeding. */
export function vcard(fields: Record<string, string>, version = '3.0'): string {
  const lines = ['BEGIN:VCARD', `VERSION:${version}`];
  for (const [name, value] of Object.entries(fields)) {
    lines.push(`${name}:${value}`);
  }
  lines.push('END:VCARD');
  return `${lines.join('\r\n')}\r\n`;
}
