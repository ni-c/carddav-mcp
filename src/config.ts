import { internalHostKind } from 'mcp-internal-hosts';

import { quoted } from './analyze.js';
import { redactUnparsedUrl } from './redact.js';

/** Default number of contacts a listing returns when the caller does not say. */
export const DEFAULT_MAX_ENTRIES = 100;

/**
 * Hard ceiling on `CARDDAV_MAX_CONTACTS`, and on the `limit` any listing accepts.
 *
 * An address book has no natural size — a phone's export is a few hundred cards,
 * a shared company book is thousands — and unlike a calendar there is no time
 * range narrowing it by default. So the bound has to come from here.
 */
export const MAX_MAX_ENTRIES = 500;

export interface Config {
  /**
   * Root of the CardDAV server, e.g. `https://dav.example.net` — discovery walks
   * from here to the principal and the address book home set. A collection URL
   * is accepted too and short-circuits discovery to that one address book.
   *
   * May be undefined together with the credentials: the server still starts and
   * lists its tools, and every call then fails with {@link missingConfigMessage}.
   */
  url: string | undefined;
  username: string | undefined;
  password: string | undefined;
  /**
   * Bearer token, as an alternative to username/password. Mutually exclusive
   * with them — a configuration carrying both is refused at startup rather than
   * silently preferring one, because which one was meant is not knowable and the
   * wrong guess authenticates as somebody else.
   */
  token: string | undefined;
  /**
   * Address books this server may touch at all, as URLs, absolute paths or final
   * path segments. Empty array means "every address book the credentials can see".
   *
   * Display names are deliberately NOT accepted: on a shared address book the
   * name is chosen by whoever shared it, it is not unique, and it changes. An
   * allowlist keyed on a mutable, externally-controlled string is not an
   * allowlist.
   */
  addressBooks: readonly string[];
  /** Contacts a listing returns when the caller passes no `limit`. */
  maxEntries: number;
  insecureTls: boolean;
  readOnly: boolean;
  /**
   * Whether a client that *can* show a dialog is asked before a guarded tool
   * acts. `ELICITATION=false` turns the dialog off — the guard stays and falls
   * back to the two-call token, so there is no setting in which a guarded call
   * goes unannounced.
   */
  elicitation: boolean;
  /**
   * Raw value of `CARDDAV_ALLOW_TOOLS` — comma-separated tool names, a prefix
   * with one trailing `*`, or `essential`. Kept unparsed on purpose: this file
   * mirrors the environment, and the names can only be checked against the tool
   * catalogue, which `buildToolFilter` does.
   */
  allowTools: string | undefined;
  /** Raw value of `CARDDAV_DENY_TOOLS`, same shape, subtracted from the above. */
  denyTools: string | undefined;
}

/** Shown when the configuration is incomplete — at startup and on every call. */
export function missingConfigMessage(missing: string[]): string {
  return (
    `missing required environment variable(s): ${missing.join(', ')}\n` +
    'Required: CARDDAV_URL (e.g. https://dav.example.net), and either ' +
    'CARDDAV_USERNAME + CARDDAV_PASSWORD or CARDDAV_TOKEN.\n' +
    'CARDDAV_URL is the root of the CardDAV server, not a single address book — ' +
    'the principal and the address book home set are discovered from it. An ' +
    'address book collection URL works too and limits the server to that one.\n' +
    'Most hosted services want an app-specific password rather than the account ' +
    'password: Nextcloud, Fastmail and iCloud all issue one per application.\n' +
    'Optional: CARDDAV_ADDRESSBOOKS to fence the server to named address books, ' +
    'CARDDAV_MAX_CONTACTS for the default listing size, ' +
    'CARDDAV_READ_ONLY=true to expose only the read tools, ' +
    'CARDDAV_ALLOW_TOOLS / CARDDAV_DENY_TOOLS to narrow the tool list, ' +
    'CARDDAV_INSECURE_TLS=true to accept self-signed certificates, ' +
    'CARDDAV_ALLOW_PLAINTEXT=true to allow a plain http:// URL to a host that ' +
    'is not loopback'
  );
}

/** Names of the required environment variables that are unset in `config`. */
export function missingConfigKeys(config: Config): string[] {
  const missing: string[] = [];
  if (!config.url) missing.push('CARDDAV_URL');
  if (!config.token && !(config.username && config.password)) {
    missing.push('CARDDAV_USERNAME + CARDDAV_PASSWORD (or CARDDAV_TOKEN)');
  }
  return missing;
}

/**
 * Reads `ELICITATION` — deliberately unprefixed, and deliberately fatal on
 * anything it does not recognise.
 *
 * Unprefixed: environment variables are process-wide, so this is one switch for
 * every server in the same environment. That is also its risk, which is why a
 * server started with it off says so on its startup line.
 *
 * Fatal: this is the one variable of the family that defaults to *on*. The others
 * fail open on a typo, which is the safe direction for them. Here a typo would
 * leave the dialog running while the operator believes it is off — and an
 * operator who believes that has no way to find out.
 */
export function parseElicitation(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  // `quoted`, short: the value is whatever was pasted into the variable, and a
  // diagnostic that repeats it in full repeats a password pasted into the
  // wrong line — escaped, so an ESC or a direction override in it cannot
  // rewrite the line it is printed on.
  console.error(
    `carddav-mcp: ELICITATION must be "true" or "false" — got ` +
      `"${quoted(raw ?? '', 40)}". Refusing to start rather than guess.`
  );
  process.exit(1);
}

/**
 * Reads a switch that turns a protection *on*, and reads it tolerantly.
 *
 * `CARDDAV_READ_ONLY=1` in a Docker Compose file, `=yes` from a shell script,
 * `=TRUE` from a Windows environment, a trailing space from a copied `.env` line:
 * an `=== 'true'` comparison answers all four with a server that quietly exposes
 * every write tool. The operator asked for the guard and does not find out that
 * they did not get it — exactly the failure a protection switch must not have.
 *
 * The direction decides the strictness, not the variable. A switch that *lifts* a
 * protection is compared strictly, so a typo leaves the protection in place; see
 * `CARDDAV_INSECURE_TLS` below.
 */
function isEnabled(raw: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(raw?.trim() ?? '');
}

/**
 * Splits a comma-separated list, dropping empty entries.
 *
 * An empty-but-set `CARDDAV_ADDRESSBOOKS` is caught by the caller rather than
 * here: "set to nothing" is a plausible way to mean "no address books at all",
 * and a server that answers that by opening every one of them is the single
 * outcome nobody wants.
 */
function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseMaxEntries(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_ENTRIES;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > MAX_MAX_ENTRIES) {
    console.error(
      `carddav-mcp: CARDDAV_MAX_CONTACTS must be an integer between 1 and ` +
        `${MAX_MAX_ENTRIES} — got "${quoted(raw, 40)}".`
    );
    process.exit(1);
  }
  return value;
}

/**
 * Reads the configuration from environment variables.
 *
 * Missing credentials are only a warning, not a fatal error: the server must be
 * able to complete the MCP handshake and answer `tools/list` without them, so
 * registries and sandbox inspectors can introspect it. A malformed URL still
 * exits — that one could send the credentials to the wrong host.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.CARDDAV_URL;
  const username = env.CARDDAV_USERNAME;
  const password = env.CARDDAV_PASSWORD;
  const token = env.CARDDAV_TOKEN;
  const rawAddressBooks = env.CARDDAV_ADDRESSBOOKS;
  const rawMaxEntries = env.CARDDAV_MAX_CONTACTS;
  // Strict, and right to be: this one *removes* a protection, so anything the
  // operator did not spell exactly has to leave certificate checking on.
  const insecureTls = env.CARDDAV_INSECURE_TLS === 'true';
  const readOnly = isEnabled(env.CARDDAV_READ_ONLY);
  const allowTools = env.CARDDAV_ALLOW_TOOLS;
  const denyTools = env.CARDDAV_DENY_TOOLS;

  const missing: string[] = [];
  if (!url) missing.push('CARDDAV_URL');
  if (!token && !(username && password)) {
    missing.push('CARDDAV_USERNAME + CARDDAV_PASSWORD (or CARDDAV_TOKEN)');
  }
  if (missing.length > 0) {
    console.error(`carddav-mcp: ${missingConfigMessage(missing)}`);
  }

  // Don't keep the credentials in the environment for the process lifetime —
  // they are visible to child processes and in /proc/<pid>/environ. Before
  // every branch that can exit or return, deliberately: an exit above this
  // line would leave them there for whatever runs next.
  //
  // The username goes with them. It is half of a credential rather than a
  // secret in its own right, and leaving it behind is the kind of asymmetry
  // that reads as "this one was judged harmless" when it was really just
  // forgotten. Nothing reads it again: it has been copied into the config.
  delete env.CARDDAV_PASSWORD;
  delete env.CARDDAV_TOKEN;
  delete env.CARDDAV_USERNAME;

  const elicitation = parseElicitation(env.ELICITATION);

  if (token && (username || password)) {
    console.error(
      'carddav-mcp: set either CARDDAV_TOKEN or CARDDAV_USERNAME + ' +
        'CARDDAV_PASSWORD, not both. Which one was meant is not knowable from ' +
        'here, and the wrong guess authenticates as somebody else.'
    );
    process.exit(1);
  }

  // Set but empty is a refusal, not an omission. Whoever wrote
  // `CARDDAV_ADDRESSBOOKS=` in a compose file meant to restrict something, and
  // answering that by exposing every address book is the one wrong outcome.
  if (rawAddressBooks !== undefined && rawAddressBooks.trim() === '') {
    console.error(
      'carddav-mcp: CARDDAV_ADDRESSBOOKS is set but empty. Remove the variable ' +
        'to allow every address book, or name the ones to allow.'
    );
    process.exit(1);
  }
  const addressBooks = splitList(rawAddressBooks);

  const maxEntries = parseMaxEntries(rawMaxEntries);

  const base: Omit<Config, 'url'> = {
    username,
    password,
    token,
    addressBooks,
    maxEntries,
    insecureTls,
    readOnly,
    elicitation,
    allowTools,
    denyTools,
  };

  if (!url) return { url: undefined, ...base };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Redacted, and deliberately so: the userinfo check below only runs once the
    // URL parses, so a value that does not parse at all but still carries
    // credentials — "https://admin:s3cret@host:99999", an out-of-range port —
    // would otherwise print the password into the MCP client's log file.
    // `redactUnparsedUrl` rather than the precise rewrite, because the precise
    // one stops at the first `/` and a password containing a `/` is exactly
    // what lands here.
    console.error(
      `carddav-mcp: CARDDAV_URL is not a valid URL: ${redactUnparsedUrl(url)}`
    );
    process.exit(1);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error(
      `carddav-mcp: CARDDAV_URL must use http:// or https:// (got ${parsed.protocol})`
    );
    process.exit(1);
  }
  // Credentials embedded in the URL would end up in logs and error messages.
  if (parsed.username || parsed.password) {
    console.error(
      'carddav-mcp: CARDDAV_URL must not contain credentials — use ' +
        'CARDDAV_USERNAME and CARDDAV_PASSWORD, or CARDDAV_TOKEN'
    );
    process.exit(1);
  }
  // Plain http to anything but loopback puts the password on the wire in clear
  // on every request, and here the payload behind it is somebody's entire
  // address book. Lifted only by a switch that is read strictly, like every
  // other switch that removes a protection.
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    if (env.CARDDAV_ALLOW_PLAINTEXT !== 'true') {
      console.error(
        'carddav-mcp: CARDDAV_URL uses plain http to a non-local host, so the ' +
          'credentials and every contact would be sent unencrypted. Use ' +
          'https://, or set CARDDAV_ALLOW_PLAINTEXT=true if this network is ' +
          'trusted end to end. Refusing to start.'
      );
      process.exit(1);
    }
    console.error(
      'carddav-mcp: WARNING: CARDDAV_URL uses plain http to a non-local host — ' +
        'the credentials and every contact are sent unencrypted ' +
        '(CARDDAV_ALLOW_PLAINTEXT=true).'
    );
  }

  // A query or a fragment on the root URL has no meaning to discovery and a
  // real cost: relative hrefs are resolved against the URL, and `?x=1/`
  // spliced onto the end of it turns `/dav?x=1/work/` into `/work/` — every
  // request then lands on the wrong path of the right host.
  if (parsed.search !== '' || parsed.hash !== '') {
    console.error(
      'carddav-mcp: CARDDAV_URL must not carry a query string or a fragment. ' +
        'Give the root of the CardDAV server, e.g. https://dav.example.net or ' +
        'https://host/dav.php.'
    );
    process.exit(1);
  }

  warnAboutUnencodedPaths(addressBooks);

  // Keep the path, drop only trailing slashes: a CARDDAV_URL of
  // https://host/dav.php is a real and common shape (Baikal), and stripping the
  // path would send discovery to a root that answers 404.
  return { url: url.replace(/\/+$/, ''), ...base };
}

/**
 * An allowlist entry written as an absolute path is compared against the
 * collection's *pathname*, which is percent-encoded. `/dav/a b/` therefore
 * matches nothing, and the only symptom is the "matches no address book"
 * warning at discovery, which points at a typo that is not there. Said once,
 * here, where the entry is read.
 */
function warnAboutUnencodedPaths(entries: readonly string[]): void {
  const suspect = entries.filter(
    // eslint-disable-next-line no-control-regex -- matching them is the point
    (entry) => entry.startsWith('/') && /[\s"<>`{|}]|[^\x20-\x7e]/.test(entry)
  );
  if (suspect.length === 0) return;
  // The predicate above selects entries *because* they carry characters a
  // terminal may not show — ESC, a direction override, a zero-width space —
  // so this is the one line where printing them raw is guaranteed to matter.
  console.error(
    `carddav-mcp: CARDDAV_ADDRESSBOOKS entr${suspect.length === 1 ? 'y' : 'ies'} ` +
      `${suspect.map((entry) => `"${quoted(entry, 80)}"`).join(', ')} contain${
        suspect.length === 1 ? 's' : ''
      } characters that appear percent-encoded in an address book path, so ` +
      'the entry will match nothing as written. Write the path the way ' +
      'list_address_books prints it (e.g. %20 for a space), or use the final ' +
      'path segment instead.'
  );
}

/**
 * There is no `src/hosts.ts` in this server, on purpose.
 *
 * The fleet's SSRF guard exists where a tool hands the backend a URL that the
 * backend then fetches. Nothing here does: a `PHOTO;VALUE=uri` is reported as
 * metadata and never retrieved, and every URL this server requests came out of
 * its own discovery and is pinned to the configured origin in `api.ts`. The
 * classifier is still a dependency, for exactly the one use below.
 */
function isLoopbackHost(hostname: string): boolean {
  // Same classifier the fleet's SSRF guard uses, so a loopback URL written as
  // http://[::1]:5232 or http://[::ffff:127.0.0.1]:5232 is recognised here too
  // and the plain-http refusal does not fire on it.
  return internalHostKind(hostname) === 'loopback';
}
