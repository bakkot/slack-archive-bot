'use strict';

function once(fn) {
  let called = false;
  return () => {
    if (called) {
      return;
    }
    called = true;
    return fn();
  };
}

/*
Use:
let lock = makeLock();

...

let done = await lock();

...

done();
*/
function makeLock() {
  let pending = [];
  let held = false;

  function done() {
    if (pending.length > 0) {
      let next = pending.shift();
      next(once(done));
    } else {
      held = false;
    }
  }

  return function lock() {
    if (held) {
      return new Promise(resolve => {
        pending.push(resolve);
      });
    }

    held = true;
    return Promise.resolve(once(done));
  };
};

/*
This isn't really a part of the lock impl, but nice in our use case.
As above, except keyed.

Use:
let locks = makeLockSet();

...

let done = await locks('some key');

...

done();
*/
function makeLockSet() {
  // poor man's extremely-limited-interface DefaultMap
  let map = new Map;
  return key => {
    if (!map.has(key)) {
      map.set(makeLock());
    }
    return map.get(key)();
  };
}

module.exports = { makeLock, makeLockSet };
