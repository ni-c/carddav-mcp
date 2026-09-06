# FAQ & troubleshooting

## One tool I expected is missing

Almost always the tool filter or read-only mode rather than a bug.

- `CARDDAV_READ_ONLY=true` registers the ten read tools and nothing else.
- `CARDDAV_ALLOW_TOOLS` and `CARDDAV_DENY_TOOLS` narrow further — see
  [choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

A filtered-out tool does not exist on the protocol: it is absent from
`tools/list` and a call to it answers "tool not found", the same as a name that
never existed. That is deliberate — a server that answered differently would tell
a caller which tools it is hiding — but it does mean the absence looks like a
missing feature.

If a name in the allow list matches nothing, the server does not start at all and
prints the real names. So a running server with a missing tool is a server that
was told to hide it.

## `Invalid URL`, or nothing works at all

`CARDDAV_URL` is the root of the CardDAV server, not one address book and not
your provider's web login. `https://cloud.example.net/remote.php/dav` for
Nextcloud, `https://example.net/dav.php` for Baikal. See
[finding the URL](/guide/getting-started#finding-the-url).

A query string or a fragment on that URL is refused at startup. It has no meaning
to discovery and a real cost — relative hrefs resolve against it, and `?x=1/`
spliced on the end turns `/dav?x=1/work/` into `/work/`.

## HTTP 401

Most hosted services want an **app-specific password**, not the account password.
Nextcloud, Fastmail and iCloud all issue one per application.

If `CARDDAV_TOKEN` is set, try username and password instead: almost no CardDAV
server takes a bearer token, and one that does not will answer 401 without
explaining why.

## HTTP 405 on everything

The URL is probably not a CardDAV endpoint. For Baikal it usually has to end in
`/dav.php`; for Nextcloud, `/remote.php/dav`.

## `search_contacts` returns nothing, or too much

`get_server_info` reports whether server-side search works at all on this
instance — it probes rather than trusting what the server advertises.

Where the server cannot filter, this server fetches the collection and matches
locally instead, and the answer says `matched_with: "client-filter"` so a slow
search has a visible reason. Where the server *can* filter, the result is still
re-checked here, because a server that filters partially is indistinguishable
from one that matched properly, and the note says how many entries were dropped.

## A group I can see in my phone is not in `list_groups`

Almost certainly the other group convention — but this server reads both, so the
more likely causes are:

- The group lives in an address book `CARDDAV_ADDRESSBOOKS` withheld.
  `list_address_books` reports how many it is hiding.
- The card is in a different address book from its members. A group can only name
  cards in its own collection; members elsewhere show up as `unresolved` in
  `get_group`.

## A contact has no birthday year

That is the card, not the server. `BDAY:--0415` means "15 April, year unknown",
which is what a phone writes when the year was never entered. It comes back as
`{ month: 4, day: 15 }` with no `year` — deliberately, rather than being dropped
for being incomplete or given an invented one.

Writing one back into a **vCard 3.0** book uses the year `1604`, because RFC 2426
has no syntax for a yearless date and 1604 is the placeholder clients settled on
for exactly this. The answer says so when it happens.

## `get_contact_photo` refuses

Two reasons, and the message says which.

The card stores its photo as a **link** rather than embedding it. This server
reports the address and does not follow it: that address was chosen by whoever
wrote the card, and fetching it would make this process a request forwarder
pointed at an arbitrary host.

Or the photo is past the half-megabyte ceiling this tool applies. `get_contact`
reports the size without fetching anything.

That ceiling is deliberately well under the one-mebibyte ceiling on reading a
card at all, and the gap is base64: an embedded photo costs a third more inside
the card than it does as bytes. A tool ceiling set above the read ceiling is a
tool ceiling that never fires — the read refuses first, with a message about
byte counts instead of one naming the tool that can help.

## Everything is `partial: true`

That is `list_contacts` working as intended. A listing asks the server for a
dozen named properties rather than for whole cards, which is the difference
between kilobytes and megabytes on a real address book. `get_contact` returns the
whole card.

Nothing is lost by it: the write tools never build on a partial card, they fetch
the whole thing first.

## A card in my address book cannot be read

`list_contacts` reports how many cards it could not parse and carries on rather
than failing the whole listing. They are usually old exports from a client that
wrote something no parser accepts.

`export_contacts` still returns them, because it hands over the raw vCard text
without parsing it — which is also why it is the right tool for finding out what
is wrong with one.

## Where the untrusted marker is, and is not

Every answer built from card content carries `untrusted: true` and
`source: "carddav"` as **fields**, not only as a sentence, so a client can check
rather than notice.

Two tools deliberately do not: `get_server_info` and `list_changes` return this
server's own words — protocol tokens, ids, counts — with no card content in them
at all. A marker on everything would be a marker on nothing.
