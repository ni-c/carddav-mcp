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
 * narrow rule reliably finds no `@` to redact. It printed the password.
 *
 * So: try the precise rewrite, and where it changed nothing but the value
 * carries an `@` anyway, give up on showing it. A length is enough to tell a
 * typo from a paste, and the scheme is the part a wrong value is usually wrong
 * about. Anything from a `?` or `#` onwards goes too — a token in a query
 * string is a credential the userinfo rule was never looking for.
 */
export function redactUnparsedUrl(url: string): string {
  const narrow = redactUrlCredentials(url);
  if (narrow !== url) return narrow;
  const scheme = URL_SCHEME.exec(url)?.[0] ?? '';
  if (url.includes('@')) {
    return `${scheme}<${url.length - scheme.length} characters, redacted>`;
  }
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : `${url.slice(0, cut)}<query redacted>`;
}
