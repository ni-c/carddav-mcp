# Connecting clients

Every example below is the same three variables. Nothing else is required.

## Claude Code

```sh
claude mcp add carddav \
  -e CARDDAV_URL=https://dav.example.net \
  -e CARDDAV_USERNAME=you \
  -e CARDDAV_PASSWORD=your-app-password \
  -- npx -y @ni-c/carddav-mcp
```

Add `-e CARDDAV_ADDRESSBOOKS=work` to fence it to one book, and
`-e CARDDAV_READ_ONLY=true` to register only the read tools.

## Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "carddav": {
      "command": "npx",
      "args": ["-y", "@ni-c/carddav-mcp"],
      "env": {
        "CARDDAV_URL": "https://dav.example.net",
        "CARDDAV_USERNAME": "you",
        "CARDDAV_PASSWORD": "your-app-password"
      }
    }
  }
}
```

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.carddav]
command = "npx"
args = ["-y", "@ni-c/carddav-mcp"]
env = { CARDDAV_URL = "https://dav.example.net", CARDDAV_USERNAME = "you", CARDDAV_PASSWORD = "your-app-password" }
```

## MCP Inspector

For looking at one tool by hand:

```sh
npx @modelcontextprotocol/inspector --cli npx -y @ni-c/carddav-mcp \
  -e CARDDAV_URL=https://dav.example.net \
  -e CARDDAV_USERNAME=you \
  -e CARDDAV_PASSWORD=your-app-password \
  --method tools/list
```

Two things about that command line, both of which cost an afternoon at least
once. The inspector does **not** pass the ambient environment through to the
server it spawns, so exporting the variables first does nothing — they go in
`-e` flags. And those flags have to come **after** the target command: put them
before it and the positional parsing shifts, the target is lost, and the
inspector quietly connects to whatever server its own catalogue file lists
instead.

Drop `--cli` for the browser UI, where the variables are entered in a form
instead.

## Docker

```sh
docker run --rm -i \
  -e CARDDAV_URL=https://dav.example.net \
  -e CARDDAV_USERNAME=you \
  -e CARDDAV_PASSWORD=your-app-password \
  ghcr.io/ni-c/carddav-mcp
```

`-i` is required and `-t` must not be: stdin and stdout are the protocol. The
image runs as the unprivileged `node` user, carries no package manager, and
writes nothing to disk.

## Through mcp-hub

A client that cannot spawn a local process — ChatGPT connectors, Claude on the
web, Cursor, LibreChat — cannot start this server the way the entries above do.

[mcp-hub](https://mcp-hub.ni-c.de) is the bridge. One container serves many stdio
MCP servers over Streamable HTTP behind a single OAuth 2.1 login, and its `/hub`
endpoint puts every server behind six meta-tools so one connector reaches all of
them. It speaks both protocol revisions, which matters here specifically: a
guarded tool in this server asks a question, and the hub carries that question
through to the person at the far end rather than answering it at the gateway.

Its configuration is Claude Code's `mcpServers` format, so the JSON above is the
entry it takes:

```json
{
  "mcpServers": {
    "carddav": {
      "command": "npx",
      "args": ["-y", "@ni-c/carddav-mcp"],
      "env": {
        "CARDDAV_URL": "https://dav.example.net",
        "CARDDAV_USERNAME": "you",
        "CARDDAV_PASSWORD": "your-app-password",
        "CARDDAV_ALLOW_TOOLS": "essential"
      }
    }
  }
}
```

Note where the tool filter goes. `CARDDAV_ALLOW_TOOLS` belongs in **this
server's environment**, as above — it decides which tools this server registers.
The hub has its own `allowTools`, and that is a different thing: it decides which
*servers* a given connector can see. Writing `"allowTools": ["essential"]` in the
hub's own configuration does nothing at all, which is the mistake this paragraph
exists to prevent.
