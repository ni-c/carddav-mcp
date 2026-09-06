import { afterEach, describe, expect, it, vi } from 'vitest';

import { testConfig } from './harness.js';

/**
 * The one code path that weakens TLS, in its own file because `vi.mock` is
 * hoisted and would reshape every other suite's `undici`.
 */

const undiciFetch = vi.fn();

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) => undiciFetch(...args),
    Agent: class {
      readonly options: unknown;
      constructor(options: unknown) {
        this.options = options;
      }
    },
  };
});

const { CardDavApi } = await import('../src/api.js');

function reply(): Response {
  return new Response(null, { status: 204, headers: { etag: '"1"' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  undiciFetch.mockReset();
});

describe('CARDDAV_INSECURE_TLS', () => {
  it('routes requests through the relaxed dispatcher only when set', async () => {
    const globalFetch = vi.fn(() => Promise.resolve(reply()));
    vi.stubGlobal('fetch', globalFetch);
    undiciFetch.mockResolvedValue(reply());

    const strict = new CardDavApi(testConfig());
    await strict.del('https://dav.example.net/x.vcf', '"1"');
    expect(undiciFetch).not.toHaveBeenCalled();
    expect(globalFetch).toHaveBeenCalledTimes(1);

    const relaxed = new CardDavApi(testConfig({ insecureTls: true }));
    await relaxed.del('https://dav.example.net/x.vcf', '"1"');
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    const init = undiciFetch.mock.calls[0]?.[1] as {
      dispatcher: { options: { connect: { rejectUnauthorized: boolean } } };
    };
    expect(init.dispatcher.options.connect.rejectUnauthorized).toBe(false);
  });

  it('never uses the relaxed dispatcher for another origin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(reply()))
    );
    const relaxed = new CardDavApi(testConfig({ insecureTls: true }));
    await expect(
      relaxed.del('https://elsewhere.example/x.vcf', '"1"')
    ).rejects.toThrow(/only the configured server/);
    expect(undiciFetch).not.toHaveBeenCalled();
  });
});
