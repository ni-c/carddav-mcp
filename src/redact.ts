/**
 * Matches the userinfo part of a URL (`scheme://user:pass@`).
 *
 * Applied as a string rewrite rather than via `new URL`, for two reasons: a value
 * that is already percent-encoded is handed back byte-identical when it holds no
 * credentials, and a value that is *not* a valid URL — the case `loadConfig`
 * reports on — still gets redacted.
 *
 * The class excludes `/?#` but deliberately not `@`, because userinfo ends at the
 * *last* `@` before the path, not the first: a password may legitimately contain
 * one, and stopping at the first would publish the tail of it as part of the host.
 * Not crossing `/` is what keeps `https://host/principals/@alice` untouched —
 * there is no `@` reachable from the scheme without passing the path.
 */
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i;

/**
 * Removes credentials from a URL before it reaches the model or a log.
 *
 * A CardDAV server never hands us a URL with credentials in it — every href comes
 * from its own namespace. This exists for the other direction: `CARDDAV_URL` as
 * the operator typed it, echoed back in a startup error. That is precisely where
 * a password pasted into the wrong variable would otherwise land in the MCP
 * client's log file.
 */
export function redactUrlCredentials(url: string): string {
  return url.replace(URL_USERINFO, '$1***@');
}

/** Just the scheme of a value, `''` when it does not start with one. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The same job for a value that did **not** parse as a URL.
 *
 * The narrow rule above cannot cross a `/`, which is correct for a URL that
 * parses and wrong for the one caller that matters. A password containing a `/`
 * is *precisely* a value `new URL` rejects — `https://user:pa/ss@dav.example.net`
 * parses its authority as `user:pa`, reads `pa` as a port and throws — so the
 * one branch that echoes the operator's raw string is the one branch where the
 * narrow rule reliably finds no `@` to redact.
 *
 * **Nothing that failed to parse is ever shown.** An earlier version tried to be
 * helpful: redact when the value carries an `@` or a query string, and otherwise
 * hand back the operator's string so a typo would be readable. That inverts the
 * default in the one place it must not be inverted — a bearer token pasted into
 * `CARDDAV_URL` instead of `CARDDAV_TOKEN` contains neither `@` nor `?`, so
 * `ghp_…`, `sk-…`, `xoxb-…`, a JWT and a Fastmail app password all fell through
 * the sieve and went verbatim into the MCP host's log file. A rule that hides
 * credentials has to hide by default and reveal by exception, not the reverse.
 *
 * What is left is the shape, which is what a wrong value is usually wrong about:
 * the scheme when there is one, and the flat statement that there is none when
 * there is not — the most common typo of all is a host with no `https://` in
 * front of it. Plus a length, which tells a typo from a paste.
 */
export function redactUnparsedUrl(url: string): string {
  const narrow = redactUrlCredentials(url);
  if (narrow !== url) return narrow;
  const scheme = URL_SCHEME.exec(url)?.[0] ?? '';
  const rest = url.length - scheme.length;
  return scheme === ''
    ? `<no scheme, ${rest} characters, redacted>`
    : `${scheme}<${rest} characters, redacted>`;
}
