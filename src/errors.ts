/**
 * Errors this server raises before, or instead of, talking to the CardDAV server.
 *
 * They live in their own module rather than next to the code that throws them so
 * that `result.ts` can map every one of them to a tool result without importing
 * half the server — `run()` is the only place that catches, and it has to know
 * all of these.
 */

/** A caller's arguments could not be used. Never reaches the network. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/**
 * The answer would not fit inside the response budget, and nothing was left to
 * drop. A refusal, so it becomes an error result rather than an envelope of a
 * shape the tool never declared.
 */
export class ResultTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResultTooLargeError';
  }
}

/**
 * The target is outside `CARDDAV_ADDRESSBOOKS`.
 *
 * Separate from {@link ToolInputError} because the two say different things to a
 * reader: one is "you got the arguments wrong", this one is "the operator fenced
 * this off". Conflating them would send somebody looking for a typo in an
 * address book name that is spelled correctly and simply not permitted.
 */
export class AddressBookNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressBookNotAllowedError';
  }
}

/**
 * `CARDDAV_ADDRESSBOOKS` cannot be applied as written.
 *
 * Distinct from {@link AddressBookNotAllowedError}, which is the fence doing its
 * job: this one says the fence itself is not buildable, so no call can be
 * answered until the operator changes the configuration. It surfaces on the
 * first tool call rather than at process start because the entries are matched
 * against address books that only exist after discovery — and discovery needs
 * the network, which a server that must stay startable without credentials
 * cannot do before it is asked.
 */
export class AllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllowlistError';
  }
}

/**
 * A write could not be guarded, so nothing was written.
 *
 * Raised before the request goes out, when the card was read without a usable
 * ETag. A genuine `412` from the server travels as a {@link CardDavApiError}
 * and gets its hint in `result.ts`.
 */
export class PreconditionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreconditionFailedError';
  }
}

/**
 * A vCard could not be parsed, or could be parsed and is not usable.
 *
 * Its own class because the two directions need different sentences and both
 * are common: a card this server is about to write and got wrong is a bug here,
 * while a card read out of the address book that no parser accepts is somebody
 * else's client having written it years ago. `run()` says which.
 */
export class VCardError extends Error {
  constructor(
    message: string,
    /** True when the card came from the server rather than from the caller. */
    public readonly fromServer = false
  ) {
    super(message);
    this.name = 'VCardError';
  }
}
