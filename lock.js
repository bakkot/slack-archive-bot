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

module.exports = { makeLock };
