import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from 'undici';

import { quoted, stripInvisible } from './analyze.js';
import {
  missingConfigKeys,
  missingConfigMessage,
  type Config,
} from './config.js';
import {
  parseDavError,
  parseMultiStatus,
  propfindBody,
  type DavResponse,
  type PropName,
} from './dav-xml.js';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Ceiling on a multistatus document.
 *
 * An `addressbook-query` with no filter is legitimately large: a few thousand
 * cards each carrying an inline `PHOTO` reaches tens of megabytes before
 * anything unusual has happened, and unlike a calendar there is no time range
 * narrowing it by default. The ceiling is not raised to fit a request; a listing
 * that does not fit is narrowed by the caller, which is what `limit` and the
 * summary projection are for.
 */
const MAX_MULTISTATUS_BYTES = 16 * 1024 * 1024;

/** Ceiling on a single vCard on the **read** path. */
const MAX_RESOURCE_BYTES = 1 * 1024 * 1024;

/**
 * Ceiling on a single vCard on the **write** path.
 *
 * Deliberately larger than the read ceiling, and the difference matters. A write
 * is a read-modify-write over the whole card, so a card this server cannot read
 * in full is one it must not write at all — a PUT built from a truncated read
 * would silently destroy an inline `PHOTO`. Above this the write tools refuse
 * instead of truncating.
 */
const MAX_ROUNDTRIP_BYTES = 8 * 1024 * 1024;

/**
 * Ceiling on a body that is only ever a status line or an error document —
 * `OPTIONS`, `PUT`, `DELETE`. Small on purpose: nothing useful arrives here, and
 * a reverse proxy's error page is the usual reason it is not empty.
 */
const MAX_STATUS_BODY_BYTES = 1 * 1024 * 1024;

/**
 * Ceilings on one `DAV:` / `Allow` token and on how many are kept.
 *
 * RFC 4918 lets a compliance class be a coded URL rather than a bare word, so
 * these are not as tight as the real values (`1`, `addressbook`, `REPORT`)
 * would allow.
 */
const MAX_TOKEN_CHARS = 128;
const MAX_TOKENS = 40;

/**
 * Ceiling on an error body that is read for its message.
 *
 * Separate from the ceilings above, and smaller than all of them: a body that
 * arrives with a non-2xx status is read only so that a DAV error document can
 * name its precondition, and `parseDavError` looks at nothing past 64 KiB
 * anyway. It is also *cut* rather than refused — a reverse proxy answering
 * `401` with a two-megabyte login page used to surface as "the answer was
 * larger than 1048576 bytes and was refused", which hid the status and the
 * hint about credentials behind a sentence about size.
 */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * How long a `401` is remembered before the credentials are tried again.
 *
 * Every request authenticates, so a wrong password is refused on every call —
 * and a model that reads "authentication refused" retries, on a tool annotated
 * read-only and cheap. Hosted providers lock an account after a handful of
 * failed logins, which turns one mistyped password into a locked mailbox. For
 * ten seconds after a `401` the same refusal is repeated from memory, with a
 * note saying when the next real attempt happens.
 */
const AUTH_COOLDOWN_MS = 10_000;

/** The longest ETag this server will send back in `If-Match`. */
const MAX_ETAG_CHARS = 1024;

export class CardDavApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    method: string,
    url: string,
    /** The DAV precondition element name, where the server named one. */
    public readonly precondition?: string
  ) {
    super(
      `CardDAV ${method} ${quoted(redactPath(url))} failed with HTTP ${status}`
    );
    this.name = 'CardDavApiError';
  }
}

/** A vCard as fetched, with the validator needed to write it back. */
export interface Resource {
  vcf: string;
  etag: string | undefined;
}

/**
 * What `/.well-known/carddav` said, in the three ways it can say it.
 *
 * `{}` covers both "no such route" and "an answer that named nothing" — a
 * caller has the same next step either way. `refusedOrigin` is the case worth
 * keeping apart: the route worked and pointed somewhere this server will not
 * follow, which is an operator's misconfigured `CARDDAV_URL` rather than a
 * server that lacks the route.
 */
export interface WellKnownProbe {
  url?: string;
  refusedOrigin?: string;
}

interface SendOptions {
  depth?: 0 | 1;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  accept?: string;
  /**
   * Only the well-known probe may set this. Every other request refuses a
   * redirect outright — following one would resend the credentials to whatever
   * host the upstream named.
   */
  redirect?: 'error' | 'manual';
}

/**
 * The WebDAV verbs this server speaks, and no others.
 *
 * There is deliberately no `mkcol` and no `move` on this class. "Not
 * implemented" is a stronger guarantee than "not exposed": it means no future
 * tool can reach one by accident, and a reader auditing what this server can do
 * to an address book collection has one short list to check. `move_contact` is
 * a PUT followed by a DELETE for the same reason — the WebDAV `MOVE` verb works
 * on collections too, and this server has no business owning that capability.
 */
export class CardDavApi {
  private readonly config: Config;
  private readonly baseUrl: string;
  private readonly authHeader: string | undefined;
  /**
   * Only set when `CARDDAV_INSECURE_TLS` is enabled. Scopes the relaxed
   * certificate validation to requests against the configured origin instead of
   * disabling it process-wide via NODE_TLS_REJECT_UNAUTHORIZED.
   */
  private readonly insecureDispatcher: Agent | undefined;
  /** The last `401`, repeated from memory until `until` — see the constant. */
  private refusedAuth: { until: number; error: CardDavApiError } | undefined;

  constructor(config: Config) {
    this.config = config;
    this.baseUrl = config.url ?? '';
    if (config.token) {
      this.authHeader = `Bearer ${config.token}`;
    } else if (config.username && config.password) {
      this.authHeader = `Basic ${Buffer.from(
        `${config.username}:${config.password}`
      ).toString('base64')}`;
    } else {
      this.authHeader = undefined;
    }
    this.insecureDispatcher = config.insecureTls
      ? new Agent({ connect: { rejectUnauthorized: false } })
      : undefined;
  }

  /** The configured root, without a trailing slash. Empty when unconfigured. */
  get url(): string {
    return this.baseUrl;
  }

  /** The origin every request and every server-supplied href is pinned to. */
  get origin(): string {
    try {
      return new URL(this.baseUrl).origin;
    } catch {
      return '';
    }
  }

  /**
   * Turns a server-supplied href into an absolute URL on the configured origin.
   *
   * This is the choke point every href from a multistatus passes through, and
   * the origin assertion is the reason it exists: a hostile or misconfigured
   * `<D:href>https://elsewhere.example/</D:href>` would otherwise receive this
   * server's credentials — and, with `CARDDAV_INSECURE_TLS` on, its relaxed
   * certificate checking too.
   *
   * Percent-encoding is preserved exactly as received. Decoding and re-encoding
   * would not round-trip: a `%2F` inside a path segment is not the same as a `/`
   * between two.
   */
  resolveHref(href: string, relativeTo: string = this.baseUrl): string {
    let resolved: URL;
    try {
      resolved = new URL(href, relativeTo);
    } catch {
      throw new Error(
        `the CardDAV server returned a link this server cannot read: ${quoted(redactPath(href))}`
      );
    }
    // The origin alone is not the whole check. `URL.origin` leaves out the
    // userinfo, so `https://x:y@host/` on the right host would pass here and
    // its credential-shaped string would go on into every request URL. And
    // `blob:https://host/…` reports the host's origin while being nothing this
    // server can fetch or address. Only a plain http(s) URL with nothing in
    // front of the host is a link this server follows.
    if (resolved.origin !== this.origin) {
      throw new Error(
        `the CardDAV server pointed at ${quoted(resolved.origin)}, which is not ` +
          `the configured server (${this.origin}). carddav-mcp does not follow ` +
          'a link to another host, because that would send your credentials ' +
          'there.'
      );
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      throw new Error(
        `the CardDAV server returned a ${quoted(resolved.protocol)} link, ` +
          'which this server does not follow.'
      );
    }
    if (resolved.username !== '' || resolved.password !== '') {
      throw new Error(
        'the CardDAV server returned a link carrying credentials, which this ' +
          'server does not follow. Every request authenticates with the ' +
          'configured credentials and nothing else.'
      );
    }
    return resolved.toString();
  }

  private async send(
    method: string,
    url: string,
    options: SendOptions = {}
  ): Promise<{
    status: number;
    ok: boolean;
    headers: Headers;
    response: Response;
  }> {
    // Credentials are only required here, not at startup, so the server can be
    // started and introspected without them.
    const missing = missingConfigKeys(this.config);
    if (missing.length > 0) throw new Error(missingConfigMessage(missing));

    // The invariant "credentials go to the configured origin and nowhere
    // else" is asserted at the sink, not left to the callers. Every caller
    // today passes a `resolveHref` or `resourceUrl` result, which already
    // satisfies it — but a property that lives in eight call sites is a
    // review conclusion, and a property that lives here is enforced.
    if (!this.isConfiguredOrigin(url)) {
      throw new Error(
        `carddav-mcp refused to send a request to ${quoted(redactPath(url))}: ` +
          `only the configured server (${this.origin}) receives its credentials.`
      );
    }

    if (this.refusedAuth !== undefined) {
      const remaining = this.refusedAuth.until - Date.now();
      if (remaining > 0) {
        const { error } = this.refusedAuth;
        const repeated = new CardDavApiError(
          error.status,
          error.body,
          method,
          url,
          error.precondition
        );
        repeated.message +=
          ' (repeated from memory: the server refused the credentials ' +
          `${Math.ceil((AUTH_COOLDOWN_MS - remaining) / 1000)} s ago, and they ` +
          `are not tried again for ${Math.ceil(remaining / 1000)} s, so a ` +
          'retry cannot lock the account)';
        throw repeated;
      }
      this.refusedAuth = undefined;
    }

    const headers: Record<string, string> = {
      'User-Agent': 'carddav-mcp',
      ...(options.accept === undefined ? {} : { Accept: options.accept }),
      ...options.headers,
    };
    if (this.authHeader !== undefined) headers.Authorization = this.authHeader;
    if (options.depth !== undefined) headers.Depth = String(options.depth);
    if (options.body !== undefined) {
      headers['Content-Type'] =
        options.contentType ?? 'application/xml; charset=utf-8';
    }

    const init: RequestInit = {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      redirect: options.redirect ?? 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };

    // The insecure dispatcher requires undici's own fetch; the default path uses
    // the (stubbable) global fetch. Only requests that actually go to the
    // configured origin may use the relaxed dispatcher.
    const useInsecure =
      this.insecureDispatcher !== undefined && this.isConfiguredOrigin(url);
    let response: Response;
    try {
      response = useInsecure
        ? ((await undiciFetch(url, {
            ...init,
            dispatcher: this.insecureDispatcher,
          } as UndiciRequestInit)) as unknown as Response)
        : await fetch(url, init);
    } catch (error) {
      // undici reports a refused redirect as `TypeError: fetch failed` with
      // the cause `unexpected redirect` — which reached the model as exactly
      // those two words, with no hint that a proxy in front of the server is
      // redirecting, or that CARDDAV_URL should name where it redirects to.
      if (isRedirectRefusal(error)) {
        throw new Error(
          `the CardDAV server answered ${method} ${quoted(redactPath(url))} ` +
            'with a redirect, which carddav-mcp does not follow: following one ' +
            'would resend the credentials to whatever address the server ' +
            'named. Set CARDDAV_URL to the address the server redirects to.',
          { cause: error }
        );
      }
      throw error;
    }

    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      response,
    };
  }

  /** `OPTIONS`: the `DAV:` compliance tokens and the allowed methods. */
  async options(url: string): Promise<{ dav: string[]; allow: string[] }> {
    const { ok, status, headers, response } = await this.send('OPTIONS', url);
    if (!ok) throw await this.failed(status, response, 'OPTIONS', url);
    await readBoundedBody(response, url, MAX_STATUS_BODY_BYTES);
    // A response header is a string the far end chose, and `get_server_info`
    // hands these two straight to the model in this server's own voice — the
    // one result in the file that is deliberately *not* marked untrusted, on
    // the grounds that everything in it is a protocol token. That is only true
    // if it is enforced here. Lowercasing already defangs `SYSTEM:`; it does
    // nothing about a sentence, an invisible character, or a header long
    // enough to fill the result budget on its own. A real compliance class is
    // a token or a coded URL, and no server sends forty of them.
    const split = (value: string | null): string[] =>
      (value ?? '')
        .split(',')
        .map((entry) =>
          stripInvisible(entry).trim().toLowerCase().slice(0, MAX_TOKEN_CHARS)
        )
        .filter((entry) => entry.length > 0)
        .slice(0, MAX_TOKENS);
    return {
      dav: split(headers.get('dav')),
      allow: split(headers.get('allow')),
    };
  }

  /** `PROPFIND` for a fixed set of properties. */
  async propfind(
    url: string,
    depth: 0 | 1,
    props: readonly PropName[]
  ): Promise<DavResponse[]> {
    return this.multiStatus('PROPFIND', url, depth, propfindBody(props));
  }

  /**
   * `REPORT` answering a multistatus: `addressbook-query`,
   * `addressbook-multiget` and `sync-collection`.
   *
   * Unlike CalDAV there is no REPORT here that answers anything other than 207 —
   * `free-busy-query` was the sister server's one exception and has no CardDAV
   * counterpart — so this method covers every REPORT this server sends.
   */
  async report(
    url: string,
    depth: 0 | 1,
    body: string
  ): Promise<DavResponse[]> {
    return this.multiStatus('REPORT', url, depth, body);
  }

  /**
   * The same, returning the `sync-token` beside the responses.
   *
   * `sync-collection` answers a multistatus that carries one extra element
   * *outside* every `<D:response>`. Reading it through `report` would drop it,
   * and a sync tool without the next token is a tool that can only ever be
   * called once.
   */
  async syncReport(
    url: string,
    body: string
  ): Promise<{ responses: DavResponse[]; syncToken: string | undefined }> {
    const { ok, status, response } = await this.send('REPORT', url, {
      depth: 0,
      body,
      accept: 'application/xml, text/xml',
    });
    if (!ok) throw await this.failed(status, response, 'REPORT', url);
    const bytes = await readBoundedBody(response, url, MAX_MULTISTATUS_BYTES);
    const text = bytes.toString('utf8');
    const where = `CardDAV REPORT ${redactPath(url)}`;
    return {
      responses: parseMultiStatus(text, where),
      syncToken: parseSyncToken(text),
    };
  }

  private async multiStatus(
    method: 'PROPFIND' | 'REPORT',
    url: string,
    depth: 0 | 1,
    body: string
  ): Promise<DavResponse[]> {
    const { ok, status, response } = await this.send(method, url, {
      depth,
      body,
      accept: 'application/xml, text/xml',
    });
    if (!ok) throw await this.failed(status, response, method, url);
    const bytes = await readBoundedBody(response, url, MAX_MULTISTATUS_BYTES);
    const text = bytes.toString('utf8');
    return parseMultiStatus(text, `CardDAV ${method} ${redactPath(url)}`);
  }

  /** `GET` a vCard. `forWrite` raises the ceiling — see the constant. */
  async get(url: string, forWrite = false): Promise<Resource> {
    const { ok, status, headers, response } = await this.send('GET', url, {
      accept: 'text/vcard, text/x-vcard;q=0.5',
    });
    if (!ok) throw await this.failed(status, response, 'GET', url);
    const bytes = await readBoundedBody(
      response,
      url,
      forWrite ? MAX_ROUNDTRIP_BYTES : MAX_RESOURCE_BYTES
    );
    return {
      vcf: bytes.toString('utf8'),
      etag: normaliseEtag(headers.get('etag')),
    };
  }

  /**
   * `PUT` a vCard.
   *
   * Exactly one of the two guards is always sent. `If-None-Match: *` creates and
   * refuses to overwrite; `If-Match: <etag>` replaces and refuses if anything
   * changed since the read. There is no unguarded PUT and no `If-Match: *` — the
   * latter is the absence of the guard wearing its clothes.
   */
  async put(
    url: string,
    vcf: string,
    guard: { ifMatch: string } | { create: true }
  ): Promise<{ etag: string | undefined; status: number }> {
    const headers =
      'create' in guard
        ? { 'If-None-Match': '*' }
        : { 'If-Match': guard.ifMatch };
    const {
      ok,
      status,
      headers: got,
      response,
    } = await this.send('PUT', url, {
      body: vcf,
      contentType: 'text/vcard; charset=utf-8',
      headers,
    });
    if (!ok) throw await this.failed(status, response, 'PUT', url);
    await readBoundedBody(response, url, MAX_STATUS_BODY_BYTES);
    return { etag: normaliseEtag(got.get('etag')), status };
  }

  /** `DELETE` a vCard, guarded by the ETag read in the same call. */
  async del(url: string, ifMatch: string): Promise<number> {
    const { ok, status, response } = await this.send('DELETE', url, {
      headers: { 'If-Match': ifMatch },
    });
    if (!ok) throw await this.failed(status, response, 'DELETE', url);
    await readBoundedBody(response, url, MAX_STATUS_BODY_BYTES);
    return status;
  }

  /**
   * Builds the error for a non-2xx answer, reading the body for its message.
   *
   * The status is decided *before* the body is read, and the body is read under
   * its own small ceiling that cuts instead of refusing — see
   * `MAX_ERROR_BODY_BYTES`. A `401` is also remembered for
   * `AUTH_COOLDOWN_MS`, so a retry inside that window is answered from memory
   * and never reaches the provider's login counter.
   */
  private async failed(
    status: number,
    response: BodyLike,
    method: string,
    url: string
  ): Promise<CardDavApiError> {
    const body = (await readErrorBody(response)).toString('utf8');
    const error = await apiError(status, body, method, url);
    if (status === 401) {
      this.refusedAuth = { until: Date.now() + AUTH_COOLDOWN_MS, error };
    }
    return error;
  }

  /**
   * The `/.well-known/carddav` probe — the one request allowed to see a redirect.
   *
   * RFC 6764 §6 defines this endpoint *as* a redirect, so refusing one here
   * would refuse the mechanism itself. `redirect: 'manual'` keeps the decision
   * in this process: the `Location` is read, run through {@link resolveHref}
   * (which pins it to the configured origin) and returned. undici never follows
   * anything.
   *
   * This is the only method that passes `redirect` to `send` at all; the verbs
   * above never do, so `redirect: 'error'` holds for every authenticated request
   * without depending on anyone remembering. `discovery.ts` is the only caller,
   * and a test asserts every other verb throws on a 3xx.
   */
  async probeWellKnown(): Promise<WellKnownProbe> {
    const url = new URL('/.well-known/carddav', this.baseUrl).toString();
    let result;
    try {
      result = await this.send('PROPFIND', url, {
        depth: 0,
        body: propfindBody(['D:current-user-principal']),
        redirect: 'manual',
      });
    } catch {
      // A server without the well-known route is the normal case, not a fault:
      // Baikal only ships it when the vhost is configured for it.
      return {};
    }
    // Nothing below reads the body, and an unread undici response holds its
    // connection until the garbage collector gets to it. Every other path in
    // this file drains through `readBoundedBody`; this one just discards.
    await result.response.body?.cancel().catch(() => undefined);
    const location = result.headers.get('location');
    if (result.status >= 300 && result.status < 400 && location) {
      // RFC 6764 §6 lets this route redirect to a *different* host — it is how
      // `example.net/.well-known/carddav` sends a client to `dav.example.net`,
      // which is the ordinary hosted-provider bootstrap. Refusing to follow it
      // is right; throwing here is not. `resolveHref` throws, and this used to
      // sit outside the `try`, so one such redirect killed discovery before
      // steps 3 and 4 ran — and the failure was memoised, so every tool call
      // for the life of the process returned it. The refused origin is worth
      // naming, though: it is exactly what `CARDDAV_URL` should have been.
      try {
        return { url: this.resolveHref(location, url) };
      } catch {
        let refusedOrigin: string | undefined;
        try {
          refusedOrigin = new URL(location, url).origin;
        } catch {
          refusedOrigin = undefined;
        }
        return refusedOrigin === undefined ? {} : { refusedOrigin };
      }
    }
    if (result.status === 207) return { url };
    return {};
  }

  /**
   * The last gate before the credentials go on the wire.
   *
   * Deliberately the *same* three conditions as {@link resolveHref} rather
   * than the origin alone. A sink that is weaker than the check upstream of it
   * is not a sink: `URL.origin` omits the userinfo, so
   * `https://x:y@dav.example.net/` satisfies "same origin" and would be sent —
   * the exact gap `resolveHref` closes, left open one layer further down where
   * it matters most.
   */
  private isConfiguredOrigin(url: string): boolean {
    try {
      const target = new URL(url);
      return (
        target.origin === this.origin &&
        (target.protocol === 'http:' || target.protocol === 'https:') &&
        target.username === '' &&
        target.password === ''
      );
    } catch {
      return false;
    }
  }
}

/**
 * Reads the `<D:sync-token>` a `sync-collection` answer carries alongside its
 * responses.
 *
 * A regex rather than a second parse: the element sits at the top level of the
 * multistatus, its content is an opaque server-chosen string, and the parser in
 * `dav-xml.ts` is shaped around `<D:response>` entries. Namespace prefixes vary
 * (`D:`, `d:`, none), which is what the optional group covers.
 */
function parseSyncToken(xml: string): string | undefined {
  const match = /<(?:[a-z0-9]+:)?sync-token>([^<]*)<\//i.exec(xml);
  const value = match?.[1]?.trim();
  if (value === undefined || value === '') return undefined;
  return isOpaqueToken(value) ? value : undefined;
}

/** The longest sync token this server will carry. Real ones are URLs. */
const MAX_SYNC_TOKEN_CHARS = 512;

/**
 * Whether a value is shaped like the token RFC 6578 §3 defines, which is a URI.
 *
 * Checked rather than cleaned, and that is the whole point. `list_changes`
 * hands its answer over as **this server's own words** — the one result shape
 * that deliberately carries no untrusted marker, on the grounds that it holds
 * ids and statuses and no card content. A sync token is the exception hiding in
 * that sentence: it is a string the DAV server chooses freely, and it arrived
 * with no decoding, no sanitising and no length at all. A hostile or
 * compromised server could put a paragraph of instructions in `<D:sync-token>`
 * and have it delivered inside the envelope the design promises is safe to read
 * as the server talking.
 *
 * Sanitising it is not available: the caller has to hand the token back
 * verbatim on the next call, so NFKC-folding or truncating it would break
 * incremental sync against a server doing nothing wrong. Validating it costs
 * nothing instead — the RFC says URI, a URI has no spaces, and prose does.
 * A value that fails is dropped, and the existing "answered without a sync
 * token" note already tells the caller what that means for the next call.
 */
export function isOpaqueToken(value: string): boolean {
  return (
    value.length <= MAX_SYNC_TOKEN_CHARS &&
    // RFC 3986's unreserved + reserved + percent, and nothing else. No spaces,
    // no controls, no invisibles.
    /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(value)
  );
}

/**
 * Builds the error, extracting a DAV precondition where the server sent one.
 *
 * A DAV error document is genuinely useful — `<C:no-uid-conflict/>` says exactly
 * what went wrong where "HTTP 403" says nothing — so it is read before the body
 * is treated as opaque text.
 */
async function apiError(
  status: number,
  body: string,
  method: string,
  url: string
): Promise<CardDavApiError> {
  const parsed = /^\s*<\?xml|^\s*<[a-z0-9]*:?(error|multistatus)/i.test(body)
    ? parseDavError(body)
    : undefined;
  return new CardDavApiError(
    status,
    body,
    method,
    url,
    parsed?.precondition ?? undefined
  );
}

/**
 * Strips an ETag down to the value, refusing a weak one.
 *
 * A weak validator cannot protect a write (RFC 9110 §8.8.1: `If-Match` requires
 * strong comparison), and a proxy is allowed to weaken a strong ETag the origin
 * issued. Returning `undefined` rather than the weak value is what makes the
 * write tools refuse with an explanation instead of quietly dropping `If-Match`
 * and racing.
 */
function normaliseEtag(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (value === '' || value.startsWith('W/')) return undefined;
  // The value goes back out in an `If-Match` header, and a header value is
  // the one place where the server's string is not merely displayed. undici
  // refuses a header carrying a control character with a `TypeError`, which
  // reached the model as `carddav-mcp: fetch failed` — and every write to that
  // card was refused that way for as long as the server kept sending it.
  // RFC 9110 §8.8.3 spells an entity tag from visible ASCII (plus obs-text);
  // anything else is not an ETag and is treated like a weak one: no guard,
  // so the write path refuses with a sentence instead.
  if (value.length > MAX_ETAG_CHARS || !isHeaderSafe(value)) return undefined;
  return value;
}

/** Whether a string can travel in an HTTP header: no controls, no DEL, no NUL. */
function isHeaderSafe(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Whether a fetch failure is undici refusing to follow a redirect.
 *
 * `redirect: 'error'` surfaces as `TypeError: fetch failed` whose `cause` is an
 * `Error` reading `unexpected redirect`. Matched on the text because undici
 * exports no error class for it.
 */
function isRedirectRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = (error as { cause?: unknown }).cause;
  const text = cause instanceof Error ? cause.message : String(cause ?? '');
  return /unexpected redirect/i.test(text) || /redirect/i.test(error.message);
}

/** Keeps a URL's query and userinfo out of an error message. */
function redactPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.replace(/\?.*$/, '');
  }
}

/** The part of a `Response` the body readers need. */
interface BodyLike {
  headers: Headers;
  body?: unknown;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Reads the body of a failed request, up to `MAX_ERROR_BODY_BYTES`.
 *
 * Unlike {@link readBoundedBody} this never throws on size: the caller is
 * already building an error about the status, and the body is only ever a
 * message to attach to it. Past the ceiling the rest is cancelled and what was
 * read is kept — a DAV error document is a few hundred bytes and sits at the
 * front; a login page past 64 KiB has nothing to say anyway.
 */
async function readErrorBody(response: BodyLike): Promise<Buffer> {
  const body = response.body;
  if (!hasStreamingBody(body)) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ERROR_BODY_BYTES) {
      return Buffer.alloc(0);
    }
    return Buffer.from(await response.arrayBuffer()).subarray(
      0,
      MAX_ERROR_BODY_BYTES
    );
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    total += value.byteLength;
    if (total >= MAX_ERROR_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES);
}

/** Minimal shape of a response body we can read incrementally. */
interface StreamingBody {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
  };
}

function hasStreamingBody(body: unknown): body is StreamingBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as StreamingBody).getReader === 'function'
  );
}

/**
 * Reads a response body, refusing anything past `maxBytes`.
 *
 * A declared `content-length` is rejected before a single byte is read; a
 * chunked response is aborted as soon as the accumulated size crosses the
 * ceiling. Responses without a streamable body — which is what the test stubs of
 * global `fetch` return — fall back to `arrayBuffer()` and are checked
 * afterwards.
 */
async function readBoundedBody(
  response: BodyLike,
  url: string,
  maxBytes: number
): Promise<Buffer> {
  const tooLarge = (): Error =>
    new Error(
      `the CardDAV server's answer for ${quoted(redactPath(url))} was larger ` +
        `than ${maxBytes} bytes and was refused. Narrow the request — a smaller ` +
        'limit, a search term, or fewer address books.'
    );

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

  const body = response.body;
  if (!hasStreamingBody(body)) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw tooLarge();
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
