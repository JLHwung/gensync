"use strict";

// These use the global symbol registry so that multiple copies of this
// library can work together in case they are not deduped.
const GENSYNC_START = Symbol.for("gensync:v1:start");
const GENSYNC_SUSPEND = Symbol.for("gensync:v1:suspend");
// An operation may pass this to the resume callback to complete without
// suspending. Drivers that allow it return it back. Drivers from older copies
// treat it as an ordinary resume, so the operation must then still suspend.
const GENSYNC_SKIP_SUSPEND = Symbol.for("gensync:v1:skip-suspend");

const GENSYNC_EXPECTED_START = "GENSYNC_EXPECTED_START";
const GENSYNC_EXPECTED_SUSPEND = "GENSYNC_EXPECTED_SUSPEND";
const GENSYNC_OPTIONS_ERROR = "GENSYNC_OPTIONS_ERROR";
const GENSYNC_RACE_NONEMPTY = "GENSYNC_RACE_NONEMPTY";
const GENSYNC_ERRBACK_NO_CALLBACK = "GENSYNC_ERRBACK_NO_CALLBACK";

module.exports = Object.assign(
  function gensync(optsOrFn) {
    let genFn = optsOrFn;
    if (typeof optsOrFn !== "function") {
      genFn = newGenerator(optsOrFn);
    } else {
      genFn = wrapGenerator(optsOrFn);
    }

    return Object.assign(genFn, makeFunctionAPI(genFn));
  },
  {
    all: buildOperation({
      name: "all",
      arity: 1,
      sync: function(iterable) {
        const items = Array.from(iterable);
        return items.map(item => evaluateSync(item));
      },
      async: function(args, resolve, reject) {
        const items = Array.from(args[0]);

        if (items.length === 0) {
          Promise.resolve().then(() => resolve([]));
          return;
        }

        let count = 0;
        const results = items.map(() => undefined);
        items.forEach((item, i) => {
          evaluateAsync(
            item,
            val => {
              results[i] = val;
              count += 1;

              if (count === results.length) resolve(results);
            },
            reject
          );
        });
      },
    }),
    race: buildOperation({
      name: "race",
      arity: 1,
      sync: function(iterable) {
        const items = Array.from(iterable);
        if (items.length === 0) {
          throw makeError("Must race at least 1 item", GENSYNC_RACE_NONEMPTY);
        }

        return evaluateSync(items[0]);
      },
      async: function(args, resolve, reject) {
        const items = Array.from(args[0]);
        if (items.length === 0) {
          throw makeError("Must race at least 1 item", GENSYNC_RACE_NONEMPTY);
        }

        for (const item of items) {
          evaluateAsync(item, resolve, reject);
        }
      },
    }),
  }
);

/**
 * Given a generator function, return the standard API object that executes
 * the generator and calls the callbacks.
 */
function makeFunctionAPI(genFn) {
  const fns = {
    sync: function(...args) {
      return evaluateSync(genFn.apply(this, args));
    },
    async: function(...args) {
      return new Promise((resolve, reject) => {
        evaluateAsync(genFn.apply(this, args), resolve, reject);
      });
    },
    errback: function(...args) {
      const cb = args.pop();
      if (typeof cb !== "function") {
        throw makeError(
          "Asynchronous function called without callback",
          GENSYNC_ERRBACK_NO_CALLBACK
        );
      }

      let gen;
      try {
        gen = genFn.apply(this, args);
      } catch (err) {
        cb(err);
        return;
      }

      evaluateAsync(gen, val => cb(undefined, val), err => cb(err));
    },
  };
  return fns;
}

function assertTypeof(type, name, value, allowUndefined) {
  if (
    typeof value === type ||
    (allowUndefined && typeof value === "undefined")
  ) {
    return;
  }

  let msg;
  if (allowUndefined) {
    msg = `Expected opts.${name} to be either a ${type}, or undefined.`;
  } else {
    msg = `Expected opts.${name} to be a ${type}.`;
  }

  throw makeError(msg, GENSYNC_OPTIONS_ERROR);
}
function makeError(msg, code) {
  return Object.assign(new Error(msg), { code });
}

/**
 * Given an options object, return a new generator that dispatches the
 * correct handler based on sync or async execution.
 */
function newGenerator({ name, arity, sync, async, errback }) {
  assertTypeof("string", "name", name, true /* allowUndefined */);
  assertTypeof("number", "arity", arity, true /* allowUndefined */);
  assertTypeof("function", "sync", sync);
  assertTypeof("function", "async", async, true /* allowUndefined */);
  assertTypeof("function", "errback", errback, true /* allowUndefined */);
  if (async && errback) {
    throw makeError(
      "Expected one of either opts.async or opts.errback, but got _both_.",
      GENSYNC_OPTIONS_ERROR
    );
  }

  if (typeof name !== "string") {
    let fnName;
    if (errback && errback.name && errback.name !== "errback") {
      fnName = errback.name;
    }
    if (async && async.name && async.name !== "async") {
      fnName = async.name.replace(/Async$/, "");
    }
    if (sync && sync.name && sync.name !== "sync") {
      fnName = sync.name.replace(/Sync$/, "");
    }

    if (typeof fnName === "string") {
      name = fnName;
    }
  }

  if (typeof arity !== "number") {
    arity = sync.length;
  }

  return buildOperation({
    name,
    arity,
    syncOnly: !async && !errback,
    sync,
    async: function(args, resolve, reject) {
      if (async) {
        async.apply(this, args).then(resolve, reject);
      } else if (errback) {
        errback.call(this, ...args, (err, value) => {
          if (err == null) resolve(value);
          else reject(err);
        });
      } else {
        resolve(sync.apply(this, args));
      }
    },
  });
}

function wrapGenerator(genFn) {
  return setFunctionMetadata(genFn.name, genFn.length, function(...args) {
    return genFn.apply(this, args);
  });
}

function buildOperation({ name, arity, sync, async, syncOnly }) {
  const definition = { sync, async, syncOnly };
  return setFunctionMetadata(name, arity, function(...args) {
    return new Operation(definition, this, args);
  });
}

// 'yield*' passes the results of these steps unchanged up through every
// delegating generator to the driver. Taking them from a real generator gives
// them the same shape as the results that generators produce, so the property
// reads along the way don't turn polymorphic. They are shared by all
// operations, since nothing modifies iterator results.
const START_RESULT = (function*() {
  yield GENSYNC_START;
})().next();
const SUSPEND_RESULT = (function*() {
  yield GENSYNC_SUSPEND;
})().next();

const OPERATION_INITIAL = 0;
const OPERATION_STARTED = 1;
const OPERATION_SUSPENDED = 2;
const OPERATION_SUSPENDED_SYNC = 3;
const OPERATION_DONE = 4;

/**
 * The handler returned by an operation. It behaves like the generator
 *
 *   function*(...args) {
 *     const resume = yield GENSYNC_START;
 *     if (!resume) return sync.call(this, args);
 *     // Start the operation, then suspend until it calls 'resume'.
 *     yield GENSYNC_SUSPEND;
 *     return result;
 *   }
 *
 * but is written by hand, since creating and resuming a real generator for
 * every operation is several times slower.
 */
class Operation {
  constructor(definition, thisArg, args) {
    this.definition = definition;
    this.thisArg = thisArg;
    this.args = args;
    this.state = OPERATION_INITIAL;
    this.settled = false;
    this.failed = false;
    this.result = undefined;
  }

  [Symbol.iterator]() {
    return this;
  }

  next(resume) {
    switch (this.state) {
      case OPERATION_INITIAL:
        this.state = OPERATION_STARTED;
        return START_RESULT;
      case OPERATION_STARTED:
        // Handle sync mode here rather than in 'start', so that the code
        // inlined into callers for it stays small.
        if (!resume) {
          return this.finishSync();
        }
        return this.start(resume);
      case OPERATION_SUSPENDED:
        this.state = OPERATION_DONE;
        if (this.failed) {
          throw this.result;
        }
        return { value: this.result, done: true };
      case OPERATION_SUSPENDED_SYNC:
        return this.finishSync();
      default:
        return { value: undefined, done: true };
    }
  }

  throw(err) {
    this.state = OPERATION_DONE;
    throw err;
  }

  return(value) {
    this.state = OPERATION_DONE;
    return { value, done: true };
  }

  start(resume) {
    const { async, syncOnly } = this.definition;
    if (syncOnly) {
      if (resume(GENSYNC_SKIP_SUSPEND) === GENSYNC_SKIP_SUSPEND) {
        return this.finishSync();
      }
      this.state = OPERATION_SUSPENDED_SYNC;
      return SUSPEND_RESULT;
    }

    // Suspend until the callbacks run. Will resume synchronously if the
    // callback was already called.
    this.state = OPERATION_SUSPENDED;
    try {
      async.call(
        this.thisArg,
        this.args,
        value => this.settle(false, value, resume),
        err => this.settle(true, err, resume)
      );
    } catch (err) {
      this.settled = true;
      this.failed = true;
      this.result = err;
      resume();
    }
    return SUSPEND_RESULT;
  }

  finishSync() {
    this.state = OPERATION_DONE;
    return {
      value: callSync(this.definition.sync, this.thisArg, this.args),
      done: true,
    };
  }

  settle(failed, result, resume) {
    if (this.settled) return;

    this.settled = true;
    this.failed = failed;
    this.result = result;
    resume();
  }
}

// Calls an operation's sync handler with the operation's arguments. V8 runs
// direct calls considerably faster than '.call' or '.apply', so this uses one
// for the common cases. It is kept separate from other call sites, and small,
// so that it inlines well without crowding out inlining in the caller.
function callSync(fn, thisArg, args) {
  if (thisArg === undefined) {
    switch (args.length) {
      case 0:
        return fn();
      case 1:
        return fn(args[0]);
      case 2:
        return fn(args[0], args[1]);
    }
  }
  return fn.apply(thisArg, args);
}

function evaluateSync(gen) {
  let value;
  while (!({ value } = gen.next()).done) {
    assertStart(value, gen);
  }
  return value;
}

function evaluateAsync(gen, resolve, reject) {
  let sync = false;
  let didSyncResume = false;
  let didSkipSuspend = false;
  const resume = request => {
    if (sync) {
      if (request === GENSYNC_SKIP_SUSPEND) {
        didSkipSuspend = true;
        return GENSYNC_SKIP_SUSPEND;
      }
      didSyncResume = true;
    } else {
      step();
    }
  };

  step();

  function step() {
    try {
      let out = gen.next();
      while (!out.done) {
        assertStart(out.value, gen);

        // If this throws, it is considered to have broken the contract
        // established for async handlers. If these handlers are called
        // synchronously, it is also considered bad behavior.
        sync = true;
        didSyncResume = false;
        didSkipSuspend = false;
        out = gen.next(resume);
        sync = false;

        if (didSkipSuspend) {
          // The operation completed without suspending, so 'out' is already
          // the generator's next step.
          continue;
        }

        assertSuspend(out, gen);

        if (!didSyncResume) {
          // Callback wasn't called synchronously, so break out of the loop
          // and let it call 'step' later.
          return;
        }

        out = gen.next();
      }

      return resolve(out.value);
    } catch (err) {
      return reject(err);
    }
  }
}

function assertStart(value, gen) {
  if (value === GENSYNC_START) return;

  throwError(
    gen,
    makeError(
      `Got unexpected yielded value in gensync generator: ${JSON.stringify(
        value
      )}. Did you perhaps mean to use 'yield*' instead of 'yield'?`,
      GENSYNC_EXPECTED_START
    )
  );
}
function assertSuspend({ value, done }, gen) {
  if (!done && value === GENSYNC_SUSPEND) return;

  throwError(
    gen,
    makeError(
      done
        ? "Unexpected generator completion. If you get this, it is probably a gensync bug."
        : `Expected GENSYNC_SUSPEND, got ${JSON.stringify(
            value
          )}. If you get this, it is probably a gensync bug.`,
      GENSYNC_EXPECTED_SUSPEND
    )
  );
}

function throwError(gen, err) {
  // Call `.throw` so that users can step in a debugger to easily see which
  // 'yield' passed an unexpected value. If the `.throw` call didn't throw
  // back to the generator, we explicitly do it to stop the error
  // from being swallowed by user code try/catches.
  if (gen.throw) gen.throw(err);
  throw err;
}

function isIterable(value) {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    !value[Symbol.iterator]
  );
}

function setFunctionMetadata(name, arity, fn) {
  if (typeof name === "string") {
    // This should always work on the supported Node versions, but for the
    // sake of users that are compiling to older versions, we check for
    // configurability so we don't throw.
    const nameDesc = Object.getOwnPropertyDescriptor(fn, "name");
    if (!nameDesc || nameDesc.configurable) {
      Object.defineProperty(
        fn,
        "name",
        Object.assign(nameDesc || {}, {
          configurable: true,
          value: name,
        })
      );
    }
  }

  if (typeof arity === "number") {
    const lengthDesc = Object.getOwnPropertyDescriptor(fn, "length");
    if (!lengthDesc || lengthDesc.configurable) {
      Object.defineProperty(
        fn,
        "length",
        Object.assign(lengthDesc || {}, {
          configurable: true,
          value: arity,
        })
      );
    }
  }

  return fn;
}
