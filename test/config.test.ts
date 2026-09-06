import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_ENTRIES,
  loadConfig,
  MAX_MAX_ENTRIES,
  missingConfigKeys,
  missingConfigMessage,
  parseElicitation,
} from '../src/config.js';
import { redactUnparsedUrl } from '../src/redact.js';

/** A minimal environment that loads without exiting. */
function env(
  overrides: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  return {
    CARDDAV_URL: 'https://dav.example.net',
    CARDDAV_USERNAME: 'tester',
    CARDDAV_PASSWORD: 'not-a-secret',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

/** Captures a `process.exit(1)` as a throw, so a test can assert on it. */
function catchExit(fn: () => unknown): { exited: boolean; errors: string[] } {
  const errors: string[] = [];
  const spyError = vi
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(' '));
    });
  const spyExit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('__exit__');
  }) as never);
  let exited = false;
  try {
    fn();
  } catch (error) {
    if (error instanceof Error && error.message === '__exit__') exited = true;
    else throw error;
  } finally {
    spyError.mockRestore();
    spyExit.mockRestore();
  }
  return { exited, errors };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ELICITATION', () => {
  it('defaults to on when unset or empty', () => {
    expect(parseElicitation(undefined)).toBe(true);
    expect(parseElicitation('')).toBe(true);
    expect(parseElicitation('  ')).toBe(true);
    expect(parseElicitation('true')).toBe(true);
    expect(parseElicitation('TRUE')).toBe(true);
  });

  it('turns off only for an exact false', () => {
    expect(parseElicitation('false')).toBe(false);
    expect(parseElicitation(' False ')).toBe(false);
  });

  it.each(['1', '0', 'off', 'no', 'yes'])(
    'refuses to start on %s rather than guessing',
    (value) => {
      const { exited, errors } = catchExit(() => parseElicitation(value));
      expect(exited).toBe(true);
      expect(errors.join('\n')).toContain('ELICITATION must be');
    }
  );

  it('has already wiped the credentials by the time it can exit', () => {
    // The ordering that matters: a fatal ELICITATION typo must not leave a
    // password in the environment for whatever attaches next.
    const environment = env({ ELICITATION: 'off' });
    catchExit(() => loadConfig(environment));
    expect(environment.CARDDAV_PASSWORD).toBeUndefined();
    expect(environment.CARDDAV_USERNAME).toBeUndefined();
    expect(environment.CARDDAV_TOKEN).toBeUndefined();
  });
});

describe('loadConfig', () => {
  it('starts without credentials so tools stay listable', () => {
    const { exited } = catchExit(() => {
      const config = loadConfig({} as NodeJS.ProcessEnv);
      expect(config.url).toBeUndefined();
      expect(missingConfigKeys(config)).toHaveLength(2);
    });
    expect(exited).toBe(false);
  });

  it('deletes the credentials from the environment object', () => {
    const environment = env({ CARDDAV_TOKEN: undefined });
    loadConfig(environment);
    expect(environment.CARDDAV_PASSWORD).toBeUndefined();
    expect(environment.CARDDAV_USERNAME).toBeUndefined();
  });

  it('keeps the path and strips only trailing slashes', () => {
    const config = loadConfig(env({ CARDDAV_URL: 'https://h/dav.php//' }));
    expect(config.url).toBe('https://h/dav.php');
  });

  it('refuses credentials embedded in the URL', () => {
    const { exited, errors } = catchExit(() =>
      loadConfig(env({ CARDDAV_URL: 'https://u:p@dav.example.net' }))
    );
    expect(exited).toBe(true);
    expect(errors.join('\n')).toContain('must not contain credentials');
  });

  it('redacts a password out of an unparseable URL', () => {
    const { exited, errors } = catchExit(() =>
      loadConfig(env({ CARDDAV_URL: 'https://admin:s3cret@host:99999' }))
    );
    expect(exited).toBe(true);
    expect(errors.join('\n')).toContain('***@');
    expect(errors.join('\n')).not.toContain('s3cret');
  });

  it.each([
    ['https://user:pass@dav.example.net/x', 'https://***@dav.example.net/x'],
    [
      'https://admin:pa/ss@dav.example.net',
      'https://<27 characters, redacted>',
    ],
    ['not-a-url-at-all', '<no scheme, 16 characters, redacted>'],
    [
      'https://dav.example.net/x?token=abc',
      'https://<27 characters, redacted>',
    ],
  ])('redactUnparsedUrl(%s)', (input, expected) => {
    // The narrow rewrite where it applies, and the shape — scheme plus a
    // length — everywhere else. Nothing that failed to parse is shown, which
    // is a deliberate reversal: the earlier version handed back the operator's
    // own string when it carried neither `@` nor `?`, and that is exactly the
    // shape of a bearer token. See the token cases below.
    expect(redactUnparsedUrl(input)).toBe(expected);
  });

  // No vendor-recognisable token shapes here, and that is deliberate rather
  // than squeamish: a realistic `xox…-` string tripped GitHub's secret scanning
  // on the very first push, and it would do so again in every fork and every
  // clone — an alert that is always a false positive is how a security tab
  // stops being read. What the rule under test cares about is the *shape* of
  // the input (no `@`, no `?`), which none of these have either.
  it.each([
    ['0123456789abcdef0123456789abcdef01234567', 'a 40-character hex API key'],
    ['bXktYXBwLXNlY3JldC12YWx1ZS1nb2VzLWhlcmU=', 'a base64 secret'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSM', 'a JWT'],
    ['abcd-efgh-ijkl-mnop', 'an app-specific password'],
  ])('never echoes %s (%s) pasted into CARDDAV_URL', (secret) => {
    // The regression this exists for: a credential put in the wrong variable
    // contains no `@` and no `?`, so every rule that redacted "where something
    // looks secret" let it through verbatim into the MCP host's log file. The
    // assertion is on the secret being absent, not on the exact replacement —
    // it must stay true however the message is reworded.
    const out = redactUnparsedUrl(secret);
    expect(out).not.toContain(secret);
    expect(out).toContain('redacted');

    const { exited, errors } = catchExit(() =>
      loadConfig(env({ CARDDAV_URL: secret }))
    );
    expect(exited).toBe(true);
    expect(errors.join('\n')).not.toContain(secret);
  });

  it('redacts a password containing a slash, which is the case that lands here', () => {
    // The precise rewrite matches userinfo only up to the first `/`, which is
    // correct for a URL that parses. But a password with a `/` in it is
    // *precisely* a URL that does not parse — `new URL` reads the authority as
    // `admin:pa`, takes `pa` for a port and throws — so the one branch that
    // echoes the operator's raw string was the one branch where the narrow
    // rule reliably found no `@`. It printed the password.
    const { exited, errors } = catchExit(() =>
      loadConfig(env({ CARDDAV_URL: 'https://admin:pa/ss@dav.example.net' }))
    );
    expect(exited).toBe(true);
    expect(errors.join('\n')).not.toContain('pa/ss');
    expect(errors.join('\n')).toContain('redacted');
  });

  it('refuses a query string or a fragment on the root URL', () => {
    for (const url of ['https://h/dav?x=1', 'https://h/dav#f']) {
      const { exited } = catchExit(() => loadConfig(env({ CARDDAV_URL: url })));
      expect(exited, url).toBe(true);
    }
  });

  it('refuses plain http to a remote host unless allowed', () => {
    const { exited, errors } = catchExit(() =>
      loadConfig(env({ CARDDAV_URL: 'http://dav.example.net' }))
    );
    expect(exited).toBe(true);
    expect(errors.join('\n')).toContain('CARDDAV_ALLOW_PLAINTEXT');
  });

  it('allows plain http to loopback without the switch', () => {
    for (const host of [
      'http://127.0.0.1:5232',
      'http://localhost:5232',
      'http://[::1]:5232',
    ]) {
      const { exited } = catchExit(() =>
        loadConfig(env({ CARDDAV_URL: host }))
      );
      expect(exited, host).toBe(false);
    }
  });

  it('recognises loopback written as an IPv4-mapped IPv6 address', () => {
    // The reason `mcp-internal-hosts` is a dependency rather than a string
    // comparison: `URL` canonicalises this to `[::ffff:7f00:1]`.
    const { exited } = catchExit(() =>
      loadConfig(env({ CARDDAV_URL: 'http://[::ffff:127.0.0.1]:5232' }))
    );
    expect(exited).toBe(false);
  });

  it('reads the plaintext override strictly', () => {
    // A switch that *lifts* a protection: anything but the exact string leaves
    // the protection in place.
    const { exited } = catchExit(() =>
      loadConfig(
        env({
          CARDDAV_URL: 'http://dav.example.net',
          CARDDAV_ALLOW_PLAINTEXT: 'yes',
        })
      )
    );
    expect(exited).toBe(true);
  });

  it('reads read-only tolerantly', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', ' Yes ']) {
      expect(
        loadConfig(env({ CARDDAV_READ_ONLY: value })).readOnly,
        value
      ).toBe(true);
    }
    for (const value of ['0', 'false', 'off', '']) {
      expect(
        loadConfig(env({ CARDDAV_READ_ONLY: value })).readOnly,
        value
      ).toBe(false);
    }
  });

  it('reads insecure TLS strictly', () => {
    expect(loadConfig(env({ CARDDAV_INSECURE_TLS: 'true' })).insecureTls).toBe(
      true
    );
    for (const value of ['1', 'yes', 'TRUE']) {
      expect(
        loadConfig(env({ CARDDAV_INSECURE_TLS: value })).insecureTls,
        value
      ).toBe(false);
    }
  });

  it('refuses both a token and a username/password pair', () => {
    const { exited, errors } = catchExit(() =>
      loadConfig(env({ CARDDAV_TOKEN: 'tok' }))
    );
    expect(exited).toBe(true);
    expect(errors.join('\n')).toContain('not both');
  });

  it('treats an empty CARDDAV_ADDRESSBOOKS as a refusal, not an omission', () => {
    const { exited, errors } = catchExit(() =>
      loadConfig(env({ CARDDAV_ADDRESSBOOKS: '  ' }))
    );
    expect(exited).toBe(true);
    expect(errors.join('\n')).toContain('set but empty');
  });

  it('splits the address book list and drops empty entries', () => {
    const config = loadConfig(env({ CARDDAV_ADDRESSBOOKS: 'work, ,private,' }));
    expect(config.addressBooks).toEqual(['work', 'private']);
  });

  it('warns about an unencoded path in the allowlist', () => {
    const { errors } = catchExit(() =>
      loadConfig(env({ CARDDAV_ADDRESSBOOKS: '/dav/a b/' }))
    );
    expect(errors.join('\n')).toContain('percent-encoded');
  });

  it('bounds CARDDAV_MAX_CONTACTS', () => {
    expect(loadConfig(env()).maxEntries).toBe(DEFAULT_MAX_ENTRIES);
    expect(loadConfig(env({ CARDDAV_MAX_CONTACTS: '7' })).maxEntries).toBe(7);
    for (const value of [
      '0',
      '-1',
      'abc',
      '1.5',
      String(MAX_MAX_ENTRIES + 1),
    ]) {
      const { exited } = catchExit(() =>
        loadConfig(env({ CARDDAV_MAX_CONTACTS: value }))
      );
      expect(exited, value).toBe(true);
    }
  });

  it('keeps the tool lists unparsed', () => {
    const config = loadConfig(
      env({ CARDDAV_ALLOW_TOOLS: 'essential', CARDDAV_DENY_TOOLS: 'list_*' })
    );
    expect(config.allowTools).toBe('essential');
    expect(config.denyTools).toBe('list_*');
  });
});

describe('missingConfigMessage', () => {
  it('names the variables and the app-password advice', () => {
    const message = missingConfigMessage(['CARDDAV_URL']);
    expect(message).toContain('CARDDAV_URL');
    expect(message).toContain('app-specific password');
    expect(message).toContain('CARDDAV_ADDRESSBOOKS');
  });

  it('does not promise a variable this server has no code for', () => {
    // The sister server's reference page listed variables it did not read and
    // marked an optional one as required. Cheap to assert, and it is the shape
    // of mistake that survives a rename.
    const message = missingConfigMessage([]);
    expect(message).not.toContain('CARDDAV_TIMEZONE');
    expect(message).not.toContain('CARDDAV_USER_EMAIL');
  });
});
