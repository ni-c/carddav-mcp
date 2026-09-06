# Environment variables

Every variable this server reads, in full. There is no configuration file.

Only `CARDDAV_URL` plus one credential pair is required; everything else has a
default that is safe to leave alone.

## Connection

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CARDDAV_URL` | yes | — | Root of the CardDAV server, e.g. `https://dav.example.net`. An address book collection URL works too and limits the server to that one book. A query string or a fragment is refused. |
| `CARDDAV_USERNAME` | yes¹ | — | Account name. Deleted from the process environment once read. |
| `CARDDAV_PASSWORD` | yes¹ | — | Password, or an app-specific password. Deleted from the process environment once read. |
| `CARDDAV_TOKEN` | yes¹ | — | Bearer token, instead of username and password. Setting both is refused at startup. Deleted from the process environment once read. |

¹ Either `CARDDAV_USERNAME` **and** `CARDDAV_PASSWORD`, or `CARDDAV_TOKEN`. Not
both — which was meant is not knowable from here, and the wrong guess
authenticates as somebody else.

Almost every CardDAV server wants the username and password. `CARDDAV_TOKEN`
exists for the rare one that does not.

## Scope

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CARDDAV_ADDRESSBOOKS` | no | every book the account can see | Comma-separated address books this server may touch, each a full URL, an absolute path, or the collection's final path segment. A **display name is not accepted** — it is chosen by whoever shared the book, is not unique, and changes. |
| `CARDDAV_MAX_CONTACTS` | no | `100` | Contacts a listing returns when the caller passes no `limit`. An integer from 1 to 500. |
| `CARDDAV_READ_ONLY` | no | `false` | `true` registers only the read tools. They do not appear in `tools/list` at all rather than failing when called. |
| `CARDDAV_ALLOW_TOOLS` | no | all tools | Comma-separated tool names, a prefix with one trailing `*`, or `essential` for the curated preset. A name matching no tool stops the server at startup. |
| `CARDDAV_DENY_TOOLS` | no | — | Same shape, subtracted from whatever the allow list left. |

Setting `CARDDAV_ADDRESSBOOKS` to an empty string is a **refusal**, not an
omission: whoever wrote `CARDDAV_ADDRESSBOOKS=` in a compose file meant to
restrict something, and answering that by opening every book is the one wrong
outcome. An entry matching two books stops the server rather than picking one.

## Transport security

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CARDDAV_INSECURE_TLS` | no | `false` | `true` accepts a self-signed certificate **on the configured host only**, through a scoped dispatcher. `NODE_TLS_REJECT_UNAUTHORIZED` is never set. It switches off the whole certificate check, hostname verification included — anyone on the path to that host can then present any certificate and receive the credentials — and the scoped dispatcher bypasses a global undici dispatcher (a proxy agent) the host process may have installed. |
| `CARDDAV_ALLOW_PLAINTEXT` | no | `false` | `true` allows a plain `http://` URL to a host that is not loopback. Without it such a URL **refuses to start**, because it would send the credentials and every contact unencrypted on every request. |

A loopback URL needs neither. `http://127.0.0.1:5232`, `http://localhost:5232`,
`http://[::1]:5232` and `http://[::ffff:127.0.0.1]:5232` are all recognised as
local — the classification is numeric rather than a string comparison, so
`127.example.com` is not.

## Asking a person

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ELICITATION` | no | `true` | **Not prefixed.** `false` makes guarded tools use the two-call token instead of raising a dialog. Anything else is fatal. |

`ELICITATION` is deliberately unprefixed, which means one
`export ELICITATION=false` reaches every MCP server in the environment. That is
its risk as well as its point, so a server started with it off prints a line
saying so.

It is also the only variable here that defaults to *on*, which is why an
unrecognised value stops the server instead of being ignored: failing open on a
typo would leave the dialog running while the operator believed it was off.

See [asking a person](/guide/approval).

## How booleans are read

The direction decides the strictness, not the variable.

A switch that **turns a protection on** is read tolerantly — `1`, `true`, `TRUE`,
`yes`, with surrounding whitespace ignored. That is `CARDDAV_READ_ONLY`. An
`=== 'true'` comparison would answer `CARDDAV_READ_ONLY=1` in a compose file with
a server that quietly exposes every write tool, and the operator would not find
out.

A switch that **lifts a protection** is compared against the exact string `true`.
That is `CARDDAV_INSECURE_TLS` and `CARDDAV_ALLOW_PLAINTEXT`. Anything the
operator did not spell exactly leaves the protection in place.

## What is not here

For completeness, because a reader may be looking for them:

- **No timezone variable.** vCard has no timezones. A `BDAY` is a date, and one
  without a year stays without a year.
- **No user-email variable.** vCard has no attendees and no scheduling, so there
  is nothing this server would need to recognise you by.
- **No cache or state directory.** This server keeps no local copy of anything.
  The only state it holds is a five-minute memo of which address books exist, in
  memory, and `list_address_books` always refreshes it.
