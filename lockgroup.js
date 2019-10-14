'use strict';

let { makeLock } = require('./lock.js');

module.exports = function lockGroup() {
  // just a defaultDict
  // leaks like a sieve, but whatever
  let map = new Map;
  return name => {
    if (!map.has(name)) {
      map.set(name, makeLock());
    }
    return map.get(name);
  };
}
