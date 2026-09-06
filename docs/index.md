---
layout: home
hero:
  name: 'carddav-mcp'
  text: 'Your address book, over the open standard'
  tagline: 'MCP server for CardDAV address books: contacts, groups and photos'
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Tools reference
      link: /reference/tools
    - theme: alt
      text: GitHub
      link: https://github.com/ni-c/carddav-mcp
# Four cards, not three and not five. VitePress picks the grid from the array
# length: four fill a row, while five and seven both fall into grid-4 and leave a
# ragged orphan row. If a fifth is worth having, fold two existing ones together.
#
# NEVER write ": " inside an unquoted details value. YAML reads it as a mapping and
# the VitePress build dies with "incomplete explicit mapping pair", pointing at a
# column rather than at the cause. Use an em dash — or quote the whole value, as
# the cards below do.
features:
  - title: One protocol, most address books
    details: 'CardDAV is the standard behind Nextcloud, Radicale, Baikal, Fastmail, mailbox.org and iCloud, so one server reaches all of them. It walks from the URL you paste to the address books behind it the way a real client does — a server root or a single collection URL both work — and reports which vCard versions each book accepts.'
  - title: Both kinds of group
    details: 'vCard 4 writes a group as KIND:group with MEMBER properties. Apple got there first and shipped X-ADDRESSBOOKSERVER-KIND on top of vCard 3, which is what most address books actually store. This server reads both and writes whichever the book already uses — because a group in the other convention is not a footnote, it is invisible in the client the person is looking at.'
  - title: Only the tools you want
    details: 'CARDDAV_READ_ONLY=true registers the read tools and nothing else. CARDDAV_ALLOW_TOOLS cuts finer — essential for a curated handful, your own comma-separated list, or a whole family with list_* — and CARDDAV_DENY_TOOLS subtracts. Whatever is filtered out does not exist on the protocol rather than failing when called, and a name that matches no tool stops the server at startup instead of quietly going missing.'
  - title: A person is asked, not just told
    details: 'The destructive tools ask a person first, through MCP elicitation — a dialog the model cannot answer on its behalf, falling back to a server-issued token bound to the exact target where the client cannot show one. Contact data is marked untrusted, and read-only mode simply does not register the write tools.'
---

<figure class="diagram">
<!-- ARCHITECTURE:START — generated from docs/assets/architecture.source.svg by `npm run assets` -->
<svg viewBox="0 0 720 268" role="img" aria-labelledby="arch-title arch-desc">
  <title id="arch-title">How carddav-mcp connects an MCP client to a CardDAV server</title>
  <desc id="arch-desc">An MCP client speaks stdio to carddav-mcp, which speaks WebDAV over HTTPS to a CardDAV server. Answers come back marked as untrusted contact content.</desc>

  <defs>
    <marker id="arch-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 z" />
    </marker>
    <marker id="arch-arrow-accent" class="accent" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 z" />
    </marker>
  </defs>

  <rect class="node" x="20" y="70" width="160" height="80" rx="10" />
  <text class="label-title" x="100" y="103" text-anchor="middle">MCP client</text>
  <text class="label-muted" x="100" y="123" text-anchor="middle">Claude, Codex, …</text>

  <rect class="node-accent" x="280" y="60" width="170" height="100" rx="10" />
  <text class="label-title" x="365" y="95" text-anchor="middle">carddav-mcp</text>
  <text class="label-muted" x="365" y="115" text-anchor="middle">17 tools</text>
  <text class="label-muted" x="365" y="133" text-anchor="middle">asks a person</text>

  <rect class="node" x="550" y="70" width="150" height="80" rx="10" />
  <text class="label-title" x="625" y="103" text-anchor="middle">CardDAV</text>
  <text class="label-muted" x="625" y="123" text-anchor="middle">Radicale, Baikal, Nextcloud, …</text>

  <path class="edge-accent" d="M180,110 L272,110" marker-end="url(#arch-arrow-accent)" />
  <text class="label-mono" x="226" y="98" text-anchor="middle">stdio</text>

  <path class="edge-accent" d="M450,110 L542,110" marker-end="url(#arch-arrow-accent)" />
  <text class="label-mono" x="496" y="98" text-anchor="middle">HTTPS</text>
  <text class="label-muted" x="496" y="130" text-anchor="middle">PROPFIND · REPORT · PUT</text>

  <path class="edge edge-dashed" d="M625,150 L625,196" marker-end="url(#arch-arrow)" />
  <text class="label-muted" x="625" y="216" text-anchor="middle">vCard, marked untrusted</text>
</svg>
<!-- ARCHITECTURE:END -->
<figcaption>One client, one server, one address book — and nothing else on the wire.</figcaption>
</figure>

![Three tool calls against a local Radicale: listing the contacts in an address book, finding one by name, and reading a group with its member count.](/demo.gif)

## Running it elsewhere

A client that cannot spawn a local process — ChatGPT connectors, Claude on the
web, Cursor, LibreChat — cannot start this server the way Claude Code does.
[mcp-hub](https://mcp-hub.ni-c.de) is the bridge: one container serves many stdio
MCP servers over Streamable HTTP behind a single OAuth 2.1 login, and it speaks
both protocol revisions, so a question this server asks reaches the person at the
far end instead of stopping at the gateway. See
[connecting clients](/guide/clients#through-mcp-hub).
