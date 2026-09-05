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
