#!/usr/bin/env node
import type { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ToolFilterError } from 'mcp-tool-allowlist';

import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.insecureTls) {
    console.error(
      'carddav-mcp: CARDDAV_INSECURE_TLS=true — TLS certificate validation is disabled for the CardDAV connection'
    );
  }
  if (config.readOnly) {
    console.error(
      'carddav-mcp: CARDDAV_READ_ONLY=true — write tools are not registered'
    );
  }
  if (config.addressBooks.length > 0) {
    console.error(
      `carddav-mcp: CARDDAV_ADDRESSBOOKS restricts this server to ${config.addressBooks.length} address book(s)`
    );
  }
  // Printed only when it is off, like the read-only line above. ELICITATION is
  // unprefixed, so one `export ELICITATION=false` reaches every MCP server in
  // the environment — this line is what makes that visible in the log of each
  // one it actually reached.
  if (!config.elicitation) {
    console.error(
      'carddav-mcp: ELICITATION=false — guarded tools fall back to the two-call token'
    );
  }

  // Built before anything is served, so a rejected tool filter still ends the
  // process rather than surfacing as a failed handshake once a client has
  // already connected.
  let pending: McpServer | undefined;
  try {
    pending = createServer(config);
  } catch (error) {
    // A bad tool list is operator feedback, not a crash: print the sentence on
    // its own rather than behind "fatal error:".
    if (error instanceof ToolFilterError) {
      console.error(`carddav-mcp: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  // stdout belongs to the protocol; everything human-readable goes to stderr.
  // `serveStdio` owns the era decision for the connection: the opening exchange
  // selects 2025-11-25 or 2026-07-28 and pins one instance from this factory for
  // its lifetime. A hand-wired `StdioServerTransport` serves only the 2025 era,
  // which is why a negotiating client's `server/discover` probe used to be
  // answered with "Method not found".
  //
  // The instance built above serves the first connection; a second call — a
  // modern probe followed by the real connection — builds a fresh one, which is
  // safe because `createServer` only registers tools.
  serveStdio(() => {
    const server = pending ?? createServer(config);
    pending = undefined;
    return server;
  });

  // Discovery deliberately does NOT run here. The server has to complete the
  // handshake and answer tools/list without credentials, so that a registry or
  // a sandbox inspector can introspect it; the first tool call is what walks to
  // the principal, and every call without configuration fails with setup
  // instructions instead.
  console.error(
    config.url
      ? `carddav-mcp: connected, targeting ${config.url}`
      : 'carddav-mcp: connected without configuration — tools are listed but every call will fail'
  );
}

// In a container node runs as PID 1 with no default signal disposition, so
// without this handler `docker stop` waits out the grace period and SIGKILLs.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((error: unknown) => {
  console.error('carddav-mcp: fatal error:', error);
  process.exit(1);
});
