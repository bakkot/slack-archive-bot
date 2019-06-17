'use strict';

let { normalize } = require('path');
let fs = require('fs');

let { makeLock } = require('./lock.js');

// let id = `${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}.${frac}`;

class LogFile {
  static extant = new Map;
  lock = makeLock();
  lines = new Map;
  stream = null;
  path;

  constructor(path) {
    this.path = path;
  }

  static async open(path) {
    let normal = normalize(path);
    if (LogFile.extant.has(normal)) {
      return LogFile.extant.get(normal);
    }
    let instance = new LogFile(normal);
    let onReady;
    LogFile.extant.set(normal, new Promise(resolve => { onReady = resolve; }));
    if (fs.existsSync(normal)) {
      let content = (await fs.promises.readFile(normal, 'utf8')).split('\n');
      if (content.length > 0 && content[content.length - 1] === '') {
        content.pop();
      }
      while (content.length > 0) {
        let line = content.shift();
        let match = line.match(/^\[([^\]]+)\] (.*)/);
        if (!match) {
          throw new Error('malformed logfile');
        }
        let { 1: id, 2: first } = match;
        let lines = [first];
        while (content.length > 0) {
          if (content[0].startsWith('[')) {
            break;
          }
          lines.push(content.shift());
        }
        instance.lines.set(id, lines.join('\n'));
      }
    }
    // console.log(JSON.stringify([...instance.lines]));
    Promise.resolve().then(() => { onReady(instance); }); // the Promise.resolve() is so that things happen in the right order
    return instance;
  }

  async addLine(id, content) {
    let done = await this.lock();
    if (this.lines.has(id)) {
      throw new Error('duplicate line ' + id);
    }
    content = content.split('\n').map((l, i) => i > 0 && l.startsWith('[') ? '\\' + l : l).join('\n');
    this.lines.set(id, content);
    if (this.stream === null) {
      this.stream = fs.createWriteStream(this.path, { flags: 'a', encoding: 'utf8' });
    }
    return new Promise(resolve => {
      this.stream.write(
        `[${id}] ${content}\n`,
        () => {
          done();
          resolve();
        },
      );
    });
  }

  async editLine(id, content) {
    let done = await this.lock();
    if (!this.lines.has(id)) {
      throw new Error('missing line ' + id);
    }
    if (this.stream !== null) {
      await new Promise(resolve => {
        this.stream.end(() => { resolve(); });
      });
      this.stream = null;
    }
    if (content === null) {
      // i.e. delete
      this.lines.delete(id);
    } else {
      this.lines.set(id, content);
    }
    let editStream = fs.createWriteStream(this.path, { flags: 'w', encoding: 'utf8' });
    for (let [id, content] of this.lines) {
      await new Promise(resolve => {
        editStream.write(`[${id}] ${content}\n`, () => { resolve(); });
      });
    }
    return new Promise(resolve => {
      editStream.end(() => {
        done();
        resolve();
      });
    });
  }
}

async function getLogFile(path) {
  return LogFile.open(path);
}

module.exports = getLogFile;
