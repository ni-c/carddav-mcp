# Security

The short version: the credentials are an address book account, the contents
belong mostly to other people, and everything a card says is treated as text a
stranger wrote. [SECURITY.md](https://github.com/ni-c/carddav-mcp/blob/main/SECURITY.md)
in the repository is the policy document — this page is the operator's view of
the same ground.

## What the credentials are worth

Anyone who obtains them can read every contact the account holds: the people
somebody knows, their private numbers, their home addresses, and often notes
about them. Unless `CARDDAV_READ_ONLY` is set they can change or delete all of
it.

Two things follow. Use an **app-specific password** where the provider offers
one, so this server holds a credential that can be revoked on its own. And treat
every environment variable it reads as a secret — including
`CARDDAV_USERNAME`, which is half of a credential rather than a harmless label,
and which is deleted from the process environment alongside the password for
exactly that reason.

The MCP client process, and therefore the model driving it, sees every tool
result. Do not point this server at an address book whose contents you would not
put in a model's context.

## What this server cannot do

Three capabilities are absent by construction rather than disabled by a setting,
and each absence is doing security work.

**It never fetches an address somebody else chose.** A `PHOTO` may be stored as a
URI, and this server reports that URI and does not retrieve it. No tool takes a
URL, so there is no way to make the process request one — which is why there is
no SSRF-guard module here at all and why `openWorldHint` is `false` on every
tool, with no exception to explain. The only host it speaks to is the one in
`CARDDAV_URL`.

**It cannot create or delete an address book.** There is no `MKCOL` verb and no
collection-level `DELETE` in the code. The worst a defect in the addressing
scheme could reach is a single card. The integration suite creates its
collections over the wire precisely because the server cannot.

**It does not import in bulk and it does not merge.** Nothing writes several
cards in one call, so one mistaken argument cannot become four hundred cards; and
deciding which of two records is current is a judgement this server declines to
make on somebody's behalf.

That last one is worth stating as a limit rather than a virtue: the property
holds for *this server*, not for the session it runs in. If the same agent also
has a shell, a web-fetch tool, or another MCP server that can post somewhere,
contact data read through this server can leave through that. Compose
accordingly.

## The fence

`CARDDAV_ADDRESSBOOKS` names the collections this server may touch. Everything
else on the account is invisible to it — not filtered late, but unreachable.

What makes that structural rather than habitual: an id decodes only through a
function that takes the address book registry as a **required argument** and
refuses a path outside it. There is no route from an id to a URL that skips the
check, so no tool can forget it by being written carelessly.

The case that demonstrates it is group membership. `create_group` and
`update_group` take contact ids and turn them into UIDs, which is the one place a
fenced-off path could plausibly be named — and it goes through the same decoder,
so a card in a book the operator withheld cannot be added to a group in one they
allowed. There is a test for exactly that.

`list_address_books` reports how many books the fence withheld rather than
quietly showing a shorter list, because an absence that is not explained reads as
a non-existence.

## Untrusted content

An address book is rarely written only by its owner. Cards arrive by import from
a phone, by sync from a company directory, and from anyone with write access to a
shared book. So names, nicknames, organisations, titles, notes, categories and
address book display names are all treated as content a stranger wrote.

They come back between markers carrying a per-call random nonce, with every line
prefixed by it. Text written before the call cannot predict either, so a card
cannot close the block early and continue in the server's voice. A reminder
follows the block, because without one the last instruction-shaped sentence in
the model's context is the attacker's.

Before that the text is normalised: zero-width and directional-override
characters removed, and markdown image syntax defused so a rendering client
cannot be induced to fetch a URL carrying data in its query string. That last one
is the EchoLeak shape
([CVE-2025-32711](https://msrc.microsoft.com/update-guide/vulnerability/CVE-2025-32711)),
where a crafted message nobody opened exfiltrated data during ordinary background
processing.

**The attack that matters most here does not run a tool.** A card asserting that
a bank's real number has changed, or that an invoice should go to a different
account, needs the model to do nothing except repeat it. There is no call to gate
and no dialog to raise, so the only defence available is to say plainly that a
contact detail on a card is a claim rather than a verified fact — which the
framing does, and which the `identity-substitution` signal reports when it sees
the shape.

Thirteen injection shapes are recognised and reported as a **signal**, never used
to drop a card. A filter that appeared to work would be an argument for trusting
whatever got through, which is exactly the wrong conclusion.

**Homoglyphs get their own signal**: `paypal` written with a Cyrillic `а` renders
identically, nothing folds them together, and in an address book that lands in
`FN` and `ORG` — the two fields a reader uses to decide whether a card is who it
says it is.

**Be clear about what framing buys.** Measured across models, delimiting
untrusted content takes resistance to injection from roughly 61% to roughly 90%.
That is a real improvement and nowhere near a guarantee. It is a speed bump; the
architecture above is the wall.

## Writing

Every write is a read-modify-write over the card as stored, guarded with
`If-Match` carrying the ETag from that same read. Never `If-Match: *`, and a weak
ETag is refused with a reason rather than dropped — a weak validator cannot
protect a write under RFC 9110, and writing anyway would silently discard
whatever another client just saved.

The half of that rule which is easy to miss: a card from a **listing** is
incomplete by design, because a listing asks for a dozen named properties rather
than whole cards. Those entries carry `partial: true`, and the write path never
accepts one — it issues its own `GET` every time. A write built on a partial card
would delete the photo, the addresses and every `X-` property the caller never
mentioned.

## Reporting something

Use [private vulnerability reporting](https://github.com/ni-c/carddav-mcp/security/advisories/new).
Not a public issue, and no real credentials, hostnames or configuration in the
report.
