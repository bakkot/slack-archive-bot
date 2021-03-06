'use strict';

/*
TODO;

handle channel renames
write non-ignored events to disk
*/


let Slack = require('slack');
let WebSocket = require('ws');
let fs = require('fs');
let path = require('path');
let https = require('follow-redirects').https; // bleh

let getLogFile = require('./logfile.js');
let lockGroup = require('./lockgroup.js');


let { oauthToken, botToken, botUserId } = require('./keys.json');


let logDir = 'logs';
let filesDir = 'logs/files';
let docsDir = 'logs/docs';

let ignoredEventTypes = new Set([
  'hello',
  'user_typing',
  'desktop_notification',
]);


(async () => {
  await fs.promises.mkdir(logDir, { recursive: true });
  await fs.promises.mkdir(filesDir, { recursive: true });
  await fs.promises.mkdir(docsDir, { recursive: true });


  // ----------------------------------------------------------------
  // get users, get channels, join channels, catch up on history

  let meta = { userMap: new Map, channelMap: new Map };

  let users = await collectAsyncIterable(
    getPaginated(Slack.users.list, { token: botToken }, res => res.members)
  );
  for (let user of users) {
    meta.userMap.set(user.id, user.real_name);
  }

  let channels = await collectAsyncIterable(
    getPaginated(Slack.conversations.list, { token: botToken }, res => res.channels)
  );
  await Promise.all(
    channels
      .map(async c => {
        meta.channelMap.set(c.id, c.name);
        if (!c.is_member) {
          await Slack.channels.invite({ token: oauthToken, channel: c.id, user: botUserId });
        }
        let dir = path.join(logDir, '#' + c.name);
        await fs.promises.mkdir(dir, { recursive: true });
        let oldest = await getLastTimestamp(dir);
        let iter = getPaginated(
          Slack.conversations.history,
          { token: oauthToken, channel: c.id, oldest }, // adding 'inclusive: false' makes this inclusive. defaults to inclusive. wat.
          r => r.messages.sort((a, b) => +a.ts - +b.ts), // pages are oldest-first, but messages within a page are newest-first
        );
        for await (let historyItem of iter) {
          // order matters; Promise.all would not be appropriate (or helpful, since logs lock)
          await saveMessage(meta, c.name, historyItem);
        }
      })
  );


  // ----------------------------------------------------------------
  // start listening!

  let result = await Slack.rtm.connect({ token: botToken });
  let rtmURL = result.url;
  let ws = new WebSocket(rtmURL);
  let timeout = null;
  function heartbeat() {
    console.log('ping', new Date);
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      console.error('lost connection');
      ws.terminate();
    }, 5 * 60 * 1000); // observationally Slack's pings come at 4-minute intervals
  }

  ws.on('open', () => {
    console.log('opened!');
    heartbeat();
  });
  ws.on('ping', heartbeat);
  ws.on('close', () => { clearTimeout(timeout); });
  ws.on('message', async raw => {
    try {
      let m = JSON.parse(raw);
      if (ignoredEventTypes.has(m.type)) {
        return;
      }
      // TODO write to disk

      switch (m.type) {
        case 'file_shared':
        case 'file_public':
        case 'channel_joined':
        case 'channel_left':
        case 'member_joined_channel': {
          break;
        }

        case 'channel_created': {
          meta.channelMap.set(m.channel.id, m.channel.name);
          await Slack.channels.invite({ token: oauthToken, channel: m.channel.id, user: botUserId });
          let dir = path.join(logDir, '#' + m.channel.name);
          // This is sync so that it can't race with a message in the channel
          fs.mkdirSync(dir, { recursive: true });
          break;
        }
        case 'message': {
          console.log('got message of type ' + (m.subtype ? m.subtype : 'message'));
          if (!meta.channelMap.has(m.channel)) {
            console.error('missing channel info for ' + m.channel, m);
            return;
          }
          await saveMessage(meta, meta.channelMap.get(m.channel), m);
          break;
        }
        case 'file_change': {
          await getFile(m.file_id);
          break;
        }
        default: {
          console.error('unknown event type ' + m.type, m);
        }
      }
    } catch (e) {
      console.error('error for event', e, raw);
    }
  });
})();


let limit = 100;
async function* getPaginated(method, opts, getList) {
  let cursor = '';
  let result = await method({ limit, ...opts });
  yield* getList(result);
  cursor = 'response_metadata' in result && result.response_metadata.next_cursor;
  while (cursor) {
    result = await method({ limit, ...opts, cursor });
    yield* getList(result);
    cursor = 'response_metadata' in result && result.response_metadata.next_cursor;
  }
}

function collectAsyncIterable(iterable) {
  return new Promise(async (resolve, reject) => {
    try {
      let result = [];
      for await (let val of iterable) {
        result.push(val);
      }
      resolve(result);
    } catch (e) {
      reject(e);
    }
  });
}

function toRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tsToFileAndId(ts) {
  let [whole, part] = ts.split('.');
  whole = +whole * 1000;
  let date = new Date(whole);
  let file = date.getFullYear().toString().padStart(4, '0') + '-' + (date.getMonth() + 1).toString().padStart(2, '0') + '-' + date.getDate().toString().padStart(2, '0') + '.txt';
  let id = date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0') + ':' + date.getSeconds().toString().padStart(2, '0') + '.' + part;
  return { file, id };
}

function fixupMessage(meta, userId, origText, files) {
  let parts = [`<${meta.userMap.has(userId) ? meta.userMap.get(userId) : userId}>`];
  if (origText !== '') {
    if (origText.includes('<@U')) {
      for (let [id, name] of meta.userMap) {
        origText = origText.replace(new RegExp('<@' + toRegExp(id) + '>', 'g'), '@' + name);
      }
    }
    parts.push(origText);
  }
  for (let file of files) {
    switch (file.mode) {
      case 'snippet':
      case 'hosted': {
        parts.push(`<file '${file.timestamp}-${file.name}'>`);
        break;
      }
      case 'docs': {
        parts.push(`<doc ${file.id}, titled "${file.title}">`);
        break;
      }
      default: {
        parts.push(`<unknown file>`);
        console.error('cannot render non-hosted file of type ' + file.mode, file);
      }
    }
  }
  return parts.join(' ');
}

async function saveMessage(meta, channelName, messageObj) {
  let dir = path.join(logDir, '#' + channelName);
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(logDir, { recursive: true });
  }

  switch (messageObj.subtype) {
    case 'channel_join': {
      break;
    }
    case void 0: {
      let text = fixupMessage(meta, messageObj.user, messageObj.text, Array.isArray(messageObj.files) ? messageObj.files : []);
      let { file, id } = tsToFileAndId(messageObj.ts);
      let log = await getLogFile(path.join(dir, file));
      await log.addLine(id, text);

      if (Array.isArray(messageObj.files)) {
        for (let file of messageObj.files) {
          switch (file.mode) {
            case 'snippet':
            case 'hosted': {
              let dest = path.join(filesDir, file.timestamp + '-' + file.name);
              if (fs.existsSync(dest)) {
                continue; // assume we've gotten it already somehow
              }
              await download(file.url_private, dest, oauthToken);
              break;
            }
            case 'docs': {
              await getFile(file.id);
              break;
            }
            default: {
              console.error('cannot handle non-hosted file of type ' + file.mode, file);
            }
          }
        }
      }
      break;
    }
    case 'message_deleted': {
      let { file, id } = tsToFileAndId(messageObj.previous_message.ts);
      let log = await getLogFile(path.join(dir, file));
      await log.editLine(id, null);
      break;
    }
    case 'message_changed': {
      let text = fixupMessage(meta, messageObj.message.user, messageObj.message.text, messageObj.message.upload ? messageObj.message.files : []);
      let { file, id } = tsToFileAndId(messageObj.previous_message.ts);
      let log = await getLogFile(path.join(dir, file));
      await log.editLine(id, text);
      break;
    }
    default: {
      console.error('unknown message type ' + messageObj.subtype, messageObj);
    }
  }
}

let docLock = lockGroup();
async function getFile(id) {
  let done = await docLock(id);
  try {
    let meta = await Slack.files.info({ token: botToken, file: id });
    // note: file comments went away in 2018; we don't bother with them here

    if (!meta.ok) {
      throw new Error('failed to get info on file ' + id + ': ' + meta.error);
    }
    let file = meta.file;

    if (typeof file.url_private !== 'string') {
      throw new Error('file ' + id + ' lacks url');
    }

    let baseName = path.join(docsDir, id);
    await fs.promises.writeFile(baseName + '-meta.json', JSON.stringify(file, null, '  '), 'utf8');
    await download(file.url_private, baseName + '.txt', oauthToken);

    let content = await fs.promises.readFile(baseName + '.txt', 'utf8');
    if (content !== '') {
      try {
        let full = JSON.parse(content).full;
        if (typeof full === 'string') {
          await fs.promises.writeFile(baseName + '-rendered.html', full, 'utf8');
        }
      } catch (e) {
        // pass
      }
    }
  } finally {
    done();
  }
}

function download(url, filename, token) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: 'Bearer ' + token } }, res => {
      let file = fs.createWriteStream(filename);
      file.on('finish', () => { resolve(); });
      res.on('error', async e => {
        try {
          await fs.promises.unlink(filename);
        } catch {}
        reject(e);
      });
      res.pipe(file);
    });
  });
}

async function getLastTimestamp(dir) {
  let files = (await fs.promises.readdir(dir)).filter(f => /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.txt$/.test(f));
  if (files.length === 0) {
    return '1000000000.000000'; // the API complains if you give it time 0
  }
  files.sort((a, b) => {
    let [aYear, aMonth, aDay] = a.slice(0, -4).split('-').map(p => +p);
    let [bYear, bMonth, bDay] = b.slice(0, -4).split('-').map(p => +p);
    return aYear === bYear
      ? aMonth === bMonth
        ? aDay - bDay
        : aMonth - bMonth
      : aYear - bYear;
  });
  let date = new Date;
  let latestFile = files[files.length - 1];
  let [year, month, day] = latestFile.slice(0, -4).split('-').map(p => +p);
  date.setYear(year);
  date.setMonth(month - 1);
  date.setDate(day);
  let latestLog = await getLogFile(path.join(dir, latestFile));
  let keys = [...latestLog.lines.keys()];
  if (keys.length === 0) {
    // file is empty (which doesn't happen in normal practice); use the oldest time on that date
    date.setHours(0);
    date.setMinutes(0);
    date.setSeconds(0);
    return Math.floor(+date / 1000).toString() + '.000000';
  }
  let latestKey = keys[keys.length - 1];
  let [whole, part] = latestKey.split('.');
  let [hour, minute, second] = whole.split(':').map(p => +p);
  date.setHours(hour);
  date.setMinutes(minute);
  date.setSeconds(second);
  return Math.floor(+date / 1000).toString() + '.' + part;
}
