# Getting started

## Requirements

- Node.js 22 or newer, or Docker.
- A CardDAV server and an account on it.

## Credentials

CardDAV authenticates with **an account name and a password**, over HTTP Basic.
There is no API key to mint and no scopes to choose — which is the first thing to
say plainly, because most MCP servers want a token and this one does not.

Most hosted services want an **app-specific password** rather than your account
password. Nextcloud, Fastmail and iCloud all issue one per application, and using
one means this server holds a credential you can revoke on its own:

- **Nextcloud** — Settings → Security → Devices & sessions → *Create new app
  password*.
- **Fastmail** — Settings → Privacy & Security → Integrations → *New app
  password*, scoped to Contacts.
- **iCloud** — appleid.apple.com → Sign-In and Security → App-Specific Passwords.
- **Radicale, Baikal, SOGo** — whatever account the server itself was configured
  with.

`CARDDAV_TOKEN` exists for the rare server that wants a bearer token instead.
Almost nothing does; if you are not sure, you want the username and password.

## Finding the URL

`CARDDAV_URL` is the **root** of the CardDAV server, not one address book. The
principal and the address book home set are discovered from it.

| Server | URL |
| --- | --- |
| Nextcloud | `https://cloud.example.net/remote.php/dav` |
| Baikal | `https://example.net/dav.php` |
| Radicale | `https://example.net:5232` |
| Fastmail | `https://carddav.fastmail.com` |
| iCloud | `https://contacts.icloud.com` |

If all you have is the URL of a single address book — the one a desktop client's
settings shows — paste that. The server recognises a collection URL and limits
itself to that one book, and says so.

## The shortest working example

```sh
CARDDAV_URL=https://dav.example.net \
CARDDAV_USERNAME=you \
CARDDAV_PASSWORD=your-app-password \
npx -y @ni-c/carddav-mcp
```

That is the whole configuration. The server prints one line to stderr saying what
it is pointed at and then speaks MCP on stdin and stdout — so running it in a
terminal like this is only useful to see that line. To actually use it, register
it with a client: [connecting clients](/guide/clients).

## Checking it works

Ask for `list_address_books` first. It is the only tool that always asks the
server rather than answering from a cache, so it is the one that proves the
credentials, the URL and the discovery walk all work at once.

If something is off, `get_server_info` is the next call. It reports the DAV
compliance tokens, which vCard versions each book accepts, and whether the two
optional features this server can use — server-side search and RFC 6578 sync —
actually work on this instance. It probes rather than trusting what the server
advertises, because a server can claim `addressbook` and still refuse a filtered
query.

## Narrowing it down

Two things are worth setting before pointing this at an account that matters:

```sh
CARDDAV_ADDRESSBOOKS=work          # only this book is visible at all
CARDDAV_READ_ONLY=true             # only the read tools are registered
```

The first is a fence: everything else on the account stays invisible, and it is
enforced where an id is decoded rather than at the edge of each tool. The second
means the write tools are not registered — they do not appear in `tools/list` and
cannot be called. Both are described in [configuration](/guide/configuration).
