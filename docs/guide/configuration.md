# Configuration

Everything is an environment variable. There is no configuration file, and there
is nothing to write to disk.

The full table with types and defaults is in the
[environment reference](/reference/environment); this page is about the choices
behind it.

## Connecting

```sh
CARDDAV_URL=https://dav.example.net
CARDDAV_USERNAME=you
CARDDAV_PASSWORD=your-app-password
```

`CARDDAV_URL` is the root of the server rather than one address book — see
[getting started](/guide/getting-started#finding-the-url) for what that means per
provider. A collection URL works too and limits the server to that one book.

`CARDDAV_TOKEN` replaces the username and password for a server that wants a
bearer token. Setting both is refused at startup rather than resolved by
preferring one: which was meant is not knowable from here, and the wrong guess
authenticates as somebody else.

**The credentials are deleted from the process environment once read**, before
any branch that can exit. They are visible in `/proc/<pid>/environ` and to child
processes until that happens, and the interesting case is the one where startup
*fails* — a missing URL, a malformed one — because that is precisely when
somebody attaches an inspector.

## TLS

`https://` always. A plain `http://` URL to anything that is not loopback
**refuses to start**, because it would put the credentials and every contact on
the wire in clear on every request. That used to be a warning in this family;
a warning on stderr in a stdio deployment is a line nobody ever reads.

```sh
CARDDAV_ALLOW_PLAINTEXT=true   # lifts the refusal, for a trusted network
CARDDAV_INSECURE_TLS=true      # accepts a self-signed certificate
```

`CARDDAV_INSECURE_TLS` is scoped to the configured host through an undici
dispatcher — `NODE_TLS_REJECT_UNAUTHORIZED` is never set, so nothing else in the
process loses certificate checking.

Both are read **strictly**: only the exact string `true`. A switch that lifts a
protection must not be turned on by a typo. `CARDDAV_READ_ONLY` is read the other
way — `1`, `yes`, `TRUE` and a stray space all work — because a switch that turns
a protection *on* should not be silently ignored either. The direction decides
the strictness, not the variable.

## Fencing the server to named address books

```sh
CARDDAV_ADDRESSBOOKS=work,private
```

Anything not named is invisible: not listed, not readable, not writable. An entry
can be a full URL, an absolute path, or the collection's final path segment.

A **display name is not accepted**, and that is a decision rather than an
omission. On a shared address book the display name is chosen by whoever shared
it, it is not unique across a principal, and it changes without notice — an
allowlist keyed on a mutable, externally controlled string is not an allowlist.

Two behaviours worth knowing:

- `list_address_books` reports how many books it **withheld**. A listing that
  silently omitted them would teach the reader they do not exist, and then a
  perfectly correct id from somewhere else looks like a bug.
- An entry matching *two* books — only possible for a bare final segment — stops
  the server rather than resolving to whichever matched first. Either choice
  would quietly grant access to a collection nobody meant.

Setting the variable to an empty string is a refusal, not an omission: whoever
wrote `CARDDAV_ADDRESSBOOKS=` in a compose file meant to restrict something.

## Read-only

```sh
CARDDAV_READ_ONLY=true
```

The write tools are **not registered**. They do not appear in `tools/list` and a
call to one answers "tool not found", byte for byte the same as a name that never
existed. Rejecting them at call time instead would advertise a capability the
server refuses to provide.

## Choosing the tools that load

Seventeen tools is a lot of context on every request, and a model picks worse
from a long list than from a short one. Two variables narrow it:

```sh
CARDDAV_ALLOW_TOOLS=essential                            # a curated six
CARDDAV_ALLOW_TOOLS=list_contacts,get_contact,create_contact
CARDDAV_ALLOW_TOOLS=list_*                               # one trailing * only
CARDDAV_DENY_TOOLS=delete_contact                        # subtracted from the above
```

`essential` selects `list_address_books`, `list_contacts`, `get_contact`,
`search_contacts`, `create_contact` and `update_contact` — enough to find a
person, read them, add one and correct one, with nothing irreversible in reach
and the whole group surface left out. It is an editorial choice, not a mechanical
one: "the read tools" is already `CARDDAV_READ_ONLY` and would add nothing.

An entry may be an exact tool name or a literal prefix with exactly one trailing
`*`. A star anywhere else is refused. Allow decides what is in; deny is
subtracted from whatever allow left.

**A name matching no tool stops the server at startup**, printing the real names.
An ignored typo would leave a tool missing from `tools/list` with nothing
pointing at the cause, and nobody traces an absence back to an environment
variable.

Under read-only the two interact in the way you would want: naming a write tool
explicitly says *read-only is suppressing it* rather than *no such tool*, because
the tool does exist and telling the truth about which is the point.

## How many contacts a listing returns

```sh
CARDDAV_MAX_CONTACTS=100    # 1 to 500, the default a listing uses
```

Every listing tool also takes a `limit` argument, which wins. There is a second,
harder ceiling behind both: a tool result is capped in bytes, and an answer past
it drops whole entries and says how many rather than being truncated mid-string.

## The dialog switch

```sh
ELICITATION=false
```

**Not prefixed**, deliberately, and that is the thing to know about it: one
`export ELICITATION=false` reaches every MCP server in the environment. Because
of that a server started with it off prints a line saying so.

It does not remove the guard. A guarded tool falls back to the two-call token
instead of raising a dialog — see [asking a person](/guide/approval). Anything it
does not recognise is **fatal**: this is the only variable of the family that
defaults to *on*, so failing open on a typo would leave the dialog running while
the operator believed it was off.
