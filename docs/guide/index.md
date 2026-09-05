# What is carddav-mcp?

An MCP server that puts a CardDAV address book in front of a model: seventeen
tools over contacts, groups and photos, on any server that speaks the standard.

CardDAV ([RFC 6352](https://datatracker.ietf.org/doc/html/rfc6352)) is WebDAV
with vCards in it. It is what Nextcloud, Radicale, Baikal, SOGo, Fastmail,
mailbox.org and iCloud all serve, which is the reason to target the protocol
rather than any one vendor's API — one server reaches all of them, and the one
you self-host works exactly like the one you pay for.

## What it is for

Finding a person and reading their card. Adding somebody, correcting a number,
keeping a group up to date. Exporting a book so there is a copy of it somewhere.
The things a person actually does with an address book, phrased as tools a model
can pick from.

## What it is not for

Being a sync client. This server reads and writes single cards over HTTP on
demand; it keeps no local copy, no cache of contacts, and no state between
calls beyond a short-lived list of which address books exist.
`list_changes` exists so that something else can keep state, not so that this
can.

It is also not a merge tool, not a bulk importer, and not a de-duplicator. Those
are judgements about people rather than operations on a protocol, and the
irreversible half of each of them is the half this server declines to own — see
[what it deliberately cannot do](/guide/security#what-this-server-cannot-do).

## The shape of it

Every tool is one or two DAV requests and a projection. There is no framework
underneath: the WebDAV verbs are a closed list, the XML request bodies are
built by hand from a fixed vocabulary, and `ical.js` is imported in exactly one
file. That is small enough to read in an afternoon, which is the property that
matters for something holding an address book's credentials.

Two decisions run through all of it and are worth knowing before anything else:

**A listing is not a card.** `list_contacts` asks the server for a dozen named
properties rather than for whole cards, because a book of a few hundred contacts
with photos is megabytes. What comes back is marked `partial`, and no write is
ever built on one — the write path fetches the whole card itself.

**Everything a card says is somebody else's writing.** Not only the notes: the
name and the organisation too, because those are the fields a reader uses to
decide who they are looking at. It is fenced, marked and reported on, never
followed. [Security](/guide/security) has the detail.

## Where to go next

- [Getting started](/guide/getting-started) — the shortest path to a working
  connection.
- [Connecting clients](/guide/clients) — Claude Code, Claude Desktop, Codex,
  Docker, mcp-hub.
- [Configuration](/guide/configuration) — every variable, and how to narrow the
  tool list.
- [Asking a person](/guide/approval) — what the dialog is, what the token
  fallback proves, and what it does not.
- [Tools reference](/reference/tools) — the full table, generated from the
  running server.
