import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The integration suite spawns the built server against real CardDAV
    // containers. It has its own config, its own timeouts and no coverage —
    // leaving it in here would make `npm test` need Docker.
    exclude: [...configDefaults.exclude, 'test/integration/**'],
    // Pinned, because several tests here exist to prove that a date does NOT
    // depend on the host's zone — and a machine whose zone happens to share an
    // offset with the fixture passes them either way. This one sits in
    // `Europe/Luxembourg`, which is `Europe/Berlin` to the second, and in the
    // sister server that made the regression test for "a floating date must
    // not be read in the host's zone" green with the bug still in place. It
    // only failed in CI, where runners are UTC. Pinning makes the local run
    // mean what the CI run means.
    env: { TZ: 'UTC' },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Entry point: only wires config and server to the stdio transport and
      // exits the process; not reachable from unit tests.
      exclude: ['src/index.ts'],
      // Measured on 2026-09-06 at 95.55 / 88.02 / 98.73 / 97.07, over 512
      // tests, after the security review. Set just below, with headroom on
      // functions. Write the missing tests instead of lowering them.
      thresholds: {
        statements: 95,
        branches: 87,
        functions: 96,
        lines: 96,
      },
    },
  },
});
