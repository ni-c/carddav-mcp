#!/usr/bin/env node
/**
 * Generates docs/reference/tools.md from the tools the server actually
 * registers, so the reference cannot drift from the code.
 *
 *   node scripts/gen-tools-doc.mjs           write the file
 *   node scripts/gen-tools-doc.mjs --check   fail if the committed file is stale
 *
 * Runs against dist/, so `npm run build` has to come first. Plain JavaScript on
 * purpose: no extra toolchain, and it works on every Node version in the matrix.
 *
 * The curated summary table in README.md is NOT generated — it groups the tools
 * by what someone would want to do with them, which is editorial. Only this
 * complete reference, with every parameter, is mechanical enough to generate.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../dist/server.js';
import { ALL_TOOLS, ESSENTIAL_TOOLS } from '../dist/tools/catalogue.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'docs', 'reference', 'tools.md');

/** Connects to a fully configured server so every tool is registered. */
async function listTools() {
  // Every field `Config` declares, spelled out. This file is plain JavaScript,
  // so nothing typechecks that claim — which is exactly how the sister server
  // ended up passing seven of its thirteen fields and saying it passed them
  // all. The assertion at the end of `listTools` is what actually holds it:
  // a field this server needs in order to register a tool, left out here,
  // shows up as a missing tool rather than as a silent omission.
  const server = createServer({
    url: 'https://dav.example.net',
    username: 'placeholder',
    password: 'placeholder',
    token: undefined,
    addressBooks: [],
    maxEntries: 100,
    insecureTls: false,
    readOnly: false,
    elicitation: true,
    allowTools: undefined,
    denyTools: undefined,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'gen-tools-doc', version: '0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  const { tools } = await client.listTools();
  await client.close();

  // See the comment above: this is the guard that makes the config claim
  // checkable from a file nothing typechecks.
  const missing = ALL_TOOLS.filter(
    (name) => !tools.some((tool) => tool.name === name)
  );
  if (missing.length > 0) {
    throw new Error(
      `the generator built a server missing ${missing.length} tool(s): ` +
        `${missing.join(', ')}. Its Config literal is probably incomplete.`
    );
  }
  return tools;
}

/** A JSON Schema node rendered as a short type name. */
function typeName(schema) {
  if (!schema) return 'unknown';
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => `\`"${v}"\``).join(' \\| ');
  }
  if (schema.type === 'array') {
    return `${typeName(schema.items)}[]`;
  }
  if (schema.type === 'object') return 'object';
  return schema.type ?? 'unknown';
}

/**
 * Markdown alone is not enough here: VitePress compiles every page as a Vue
 * template, so a description containing `filter_value=<author id>` is parsed as
 * an unclosed HTML tag and fails the docs build. Angle brackets therefore become
 * entities, and `{{` — Vue interpolation — is broken up.
 */
function escapeCell(text) {
  return (
    String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\{\{/g, '{&#123;')
      // Backslashes first: the pipe escape below introduces one, and an input
      // that already contained `\|` would otherwise come out as `\\|` — an
      // escaped backslash followed by a live pipe, which splits the table cell.
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function renderTool(tool) {
  // `?? true` rather than a plain read: the specification gives
  // destructiveHint a default of *true*, so a tool that omits it is claiming to
  // be destructive. Reading it as falsy would have this page understate exactly
  // the tools whose annotation somebody forgot. Every tool states all four
  // today — a test insists on it — so this is a guard against the next one, not
  // a description of the current catalogue.
  const kind = tool.annotations?.readOnlyHint
    ? 'read-only'
    : (tool.annotations?.destructiveHint ?? true)
      ? 'write, destructive'
      : 'write';
  // Read off the schema rather than from a list kept next to it: a tool is
  // guarded exactly when it accepts the fallback token, and that is a fact
  // about this server's own registration.
  const asks = Object.hasOwn(
    tool.inputSchema?.properties ?? {},
    'confirm_token'
  )
    ? ' 👤'
    : '';
  // Generated from the same constant the filter reads, so "which tools does
  // `essential` select" cannot be written down twice and drift.
  const preset = ESSENTIAL_TOOLS.includes(tool.name) ? ', **essential**' : '';

  const lines = [`### \`${tool.name}\`${asks}`, ''];
  if (tool.title) lines.push(`**${tool.title}** — ${kind}${preset}`, '');
  lines.push(escapeCell(tool.description), '');

  const properties = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const names = Object.keys(properties);

  if (names.length === 0) {
    lines.push('Takes no parameters.', '');
    return lines;
  }

  lines.push(
    '| Parameter | Type | Required | Description |',
    '| --- | --- | --- | --- |'
  );
  for (const name of names) {
    const schema = properties[name];
    lines.push(
      `| \`${name}\` | ${typeName(schema)} | ${required.has(name) ? 'yes' : 'no'} | ${escapeCell(schema?.description)} |`
    );
  }
  lines.push('');
  return lines;
}

function render(tools) {
  const read = tools.filter((t) => t.annotations?.readOnlyHint);
  const write = tools.filter((t) => !t.annotations?.readOnlyHint);

  const out = [
    '<!--',
    '  GENERATED FILE — do not edit by hand.',
    '  Regenerate with: npm run build && npm run docs:tools',
    '  The CI test job fails when this file is out of date.',
    '-->',
    '',
    '# Tool reference',
    '',
    `All ${tools.length} tools: ${read.length} read, ${write.length} write.`,
    'With `CARDDAV_READ_ONLY=true` the write tools are not registered at all —',
    'they do not appear in `tools/list`.',
    '',
    `All ${tools.length} are registered unless you say otherwise. \`CARDDAV_ALLOW_TOOLS\``,
    'and `CARDDAV_DENY_TOOLS` narrow the list to the ones you want, and',
    `\`CARDDAV_ALLOW_TOOLS=essential\` selects the ${ESSENTIAL_TOOLS.length} marked **essential**`,
    'below — see [choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).',
    '',
    '👤 marks a tool that **asks a person** before it acts, through MCP',
    'elicitation — a dialog the model cannot answer on its behalf. Where the',
    'client cannot show one, it falls back to a two-call `confirm_token` bound',
    'to the exact target and expiring after five minutes, and says which of the',
    'two it was. `ELICITATION=false` takes that fallback deliberately; it never',
    'removes the guard. See [Asking a person](/guide/approval).',
    '',
    'Every tool declares all four MCP annotations — `readOnlyHint`,',
    '`destructiveHint`, `idempotentHint`, `openWorldHint`. They are a hint a',
    'client may ignore; the dialog is enforced here and cannot be, which is why',
    'the two lists are not the same one.',
    '',
    'Every tool also declares an `outputSchema` and answers in both channels at',
    'once — the same object as `structuredContent`, and as JSON in a text block.',
    'Every answer built from address book content additionally carries',
    '`untrusted: true` and `source: "carddav"` as **fields**, so a client can',
    'check rather than notice. Two tools deliberately do not: `get_server_info`',
    "and `list_changes` return this server's own words — protocol tokens, ids",
    'and counts, with no card content in them at all. A marker on everything',
    'would be a marker on nothing.',
    '',
    '## Read tools',
    '',
  ];
  for (const tool of read) out.push(...renderTool(tool));
  out.push('## Write tools', '');
  for (const tool of write) out.push(...renderTool(tool));

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

const tools = await listTools();
const generated = render(tools);

if (process.argv.includes('--check')) {
  let current = null;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    console.error(`${target} is missing — run: npm run docs:tools`);
    process.exit(1);
  }
  if (current !== generated) {
    console.error(
      `${target} is out of date — run: npm run build && npm run docs:tools`
    );
    process.exit(1);
  }
  console.log(`${target} is up to date (${tools.length} tools)`);
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, generated);
  console.log(`wrote ${target} (${tools.length} tools)`);
}
