import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolFilterError } from 'mcp-tool-allowlist';

import { createServer } from '../src/server.js';
import {
  ALL_TOOLS,
  ESSENTIAL_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
} from '../src/tools/catalogue.js';
import { connect, testConfig, type Connected } from './harness.js';

/**
 * What is left of the filter suite once `mcp-tool-allowlist` owns the
 * semantics.
 *
 * The library has its own tests for patterns, presets and the shape of every
 * error. What stays here is the half only this repository can assert: that the
 * catalogue matches the tools actually registered, that the messages name
 * *this* server's variables, and that the gate is wired to the right switch.
 *
 * The tool names appear exactly once, in the catalogue import. A second copy
 * here would be the thing that drifts.
 */

let session: Connected | undefined;

afterEach(async () => {
  await session?.close();
  session = undefined;
  vi.unstubAllGlobals();
});

async function names(
  config: Parameters<typeof connect>[0] = {}
): Promise<string[]> {
  session = await connect(config);
  const { tools } = await session.client.listTools();
  await session.close();
  session = undefined;
  return tools.map((tool) => tool.name).sort();
}

describe('the catalogue', () => {
  it('is exactly the set of tools the server registers', async () => {
    expect(await names()).toEqual([...ALL_TOOLS].sort());
  });

  it('splits into read and write with no overlap', () => {
    expect([...READ_TOOLS, ...WRITE_TOOLS].sort()).toEqual(
      [...ALL_TOOLS].sort()
    );
    for (const tool of READ_TOOLS) {
      expect(WRITE_TOOLS as readonly string[]).not.toContain(tool);
    }
  });

  it('uses only tool-shaped names, and none of them is a reserved word', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool, tool).toMatch(/^[a-z0-9_]+$/);
      expect(tool).not.toBe('essential');
    }
  });

  it('has an essential preset that is a proper subset of five to eight', () => {
    expect(new Set(ESSENTIAL_TOOLS).size).toBe(ESSENTIAL_TOOLS.length);
    expect(ESSENTIAL_TOOLS.length).toBeGreaterThanOrEqual(5);
    expect(ESSENTIAL_TOOLS.length).toBeLessThanOrEqual(8);
    expect(ESSENTIAL_TOOLS.length).toBeLessThan(ALL_TOOLS.length);
    for (const tool of ESSENTIAL_TOOLS) {
      expect(ALL_TOOLS, tool).toContain(tool);
    }
  });

  it('leaves everything irreversible out of the preset', () => {
    for (const tool of ['delete_contact', 'delete_group', 'move_contact']) {
      expect(ESSENTIAL_TOOLS).not.toContain(tool);
    }
  });
});

describe('selecting tools', () => {
  it('registers the preset for essential', async () => {
    expect(await names({ allowTools: 'essential' })).toEqual(
      [...ESSENTIAL_TOOLS].sort()
    );
  });

  it('takes an exact list', async () => {
    expect(await names({ allowTools: 'list_contacts, get_contact' })).toEqual([
      'get_contact',
      'list_contacts',
    ]);
  });

  it('takes a trailing-star prefix', async () => {
    expect(await names({ allowTools: 'list_*' })).toEqual([
      'list_address_books',
      'list_changes',
      'list_contacts',
      'list_groups',
    ]);
  });

  it('subtracts the deny list from whatever the allow list left', async () => {
    expect(
      await names({ allowTools: 'list_*', denyTools: 'list_changes' })
    ).toEqual(['list_address_books', 'list_contacts', 'list_groups']);
  });

  it('treats a whitespace-only value as unset', async () => {
    // `X_ALLOW_TOOLS=` in a compose file is not "allow nothing".
    expect(await names({ allowTools: '   ' })).toHaveLength(ALL_TOOLS.length);
  });
});

describe('refusing an unusable list', () => {
  function build(config: Parameters<typeof testConfig>[0]): () => void {
    return () => createServer(testConfig(config));
  }

  it('names the valid tools when an entry matches nothing', () => {
    expect(build({ allowTools: 'delete_thing' })).toThrow(ToolFilterError);
    expect(build({ allowTools: 'delete_thing' })).toThrow(/delete_contact/);
  });

  it('refuses a star that is not last', () => {
    expect(build({ allowTools: '*_contact' })).toThrow(ToolFilterError);
    expect(build({ allowTools: 'list_*_x' })).toThrow(ToolFilterError);
  });

  it('refuses a list that leaves nothing', () => {
    expect(build({ denyTools: '*' })).toThrow(/empty tool list/i);
  });

  it('throws rather than exiting, so the suite can build servers in-process', () => {
    // `process.exit` in `createServer` would take the test runner with it;
    // `src/index.ts` is what turns this into exit 1.
    expect(build({ allowTools: 'nope' })).toThrow(ToolFilterError);
  });

  it('names this server’s own variables in the message', () => {
    try {
      createServer(testConfig({ allowTools: 'nope' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('CARDDAV_ALLOW_TOOLS');
    }
  });
});

describe('together with read-only mode', () => {
  it('registers exactly the read tools', async () => {
    expect(await names({ readOnly: true })).toEqual([...READ_TOOLS].sort());
  });

  it('narrows the preset to its read half', async () => {
    const expected = ESSENTIAL_TOOLS.filter((tool) =>
      (READ_TOOLS as readonly string[]).includes(tool)
    ).sort();
    expect(await names({ readOnly: true, allowTools: 'essential' })).toEqual(
      expected
    );
  });

  it('says read-only is the reason, not that the tool is unknown', () => {
    // The one answer that would be wrong: the tool exists, and read-only is
    // suppressing it.
    try {
      createServer(
        testConfig({ readOnly: true, allowTools: 'delete_contact' })
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('CARDDAV_READ_ONLY');
      expect((error as Error).message).not.toMatch(/no tool matches/);
    }
  });

  it('leaves deny exempt from the write-tool rule', async () => {
    expect(
      await names({ readOnly: true, denyTools: 'delete_contact' })
    ).toEqual([...READ_TOOLS].sort());
  });
});

describe('a filtered-out tool', () => {
  it('answers not found, exactly as an unknown tool does', async () => {
    session = await connect({ allowTools: 'list_contacts' });
    const suppressed = session.client.callTool({
      name: 'delete_contact',
      arguments: { id: 'x' },
    });
    const unknown = session.client.callTool({
      name: 'no_such_tool',
      arguments: {},
    });
    // Indistinguishable on purpose: a server that answered differently would
    // tell a caller which tools it is hiding.
    const [a, b] = await Promise.all([
      suppressed.catch((error: Error) => error.message),
      unknown.catch((error: Error) => error.message),
    ]);
    expect(a).toMatch(/not found/i);
    expect(String(a).replace('delete_contact', 'X')).toBe(
      String(b).replace('no_such_tool', 'X')
    );
  });
});
