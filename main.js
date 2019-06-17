'use strict';

let Slack = require('slack');
let WebSocket = require('ws');
let fs = require('fs');
let path = require('path');

let getLogFile = require('./logfile.js');

let { oauthToken, botToken, botUserId } = require('./keys.json');

let logDir = 'logs';

// things we _actually_ ignore
let ignoredMessageTypes = new Set([
  'hello',
  'user_typing',
  'desktop_notification',
]);

// things we handle only by logging the event to disk
let loggedMessageTypes = new Set([
  'file_shared',
  'file_public',
  'channel_joined',
  'member_joined_channel',
]);

/*
TODO;

handle channel renames
save files
write non-ignored events to disk
*/


function toRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tsToFileAndId(ts) {
  let [whole, part] = ts.split('.');
  whole = +whole * 1000;
  let date = new Date(whole);
  let file = date.getFullYear().toString().padStart(4, '0') + '-' + date.getMonth().toString().padStart(2, '0') + '-' + date.getDate().toString().padStart(2, '0') + '.txt';
  let id = date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0') + ':' + date.getSeconds().toString().padStart(2, '0') + '.' + part;
  return { file, id };
}

(async () => {
  /*
    setup: list channels, find channels bot is not in, invite bot to those
    then for each channel the bot is in, find previous message, delta from previous stored message, archive those between
    then go!
  */

  function fixupMessage(userId, origText, files) {
    let text = `<${userMap.has(userId) ? userMap.get(userId) : userId}> ${origText}`;
    if (text.includes('<@U')) {
      for (let [id, name] of userMap) {
        text = text.replace(new RegExp('<@' + toRegExp(id) + '>', 'g'), '@' + name);
      }
    }
    for (let file of files) {
      text += ` <attached file '${file.timestamp}-${file.name}'>`;
    }
    return text;
  }

  async function saveMessage(channelName, messageObj) {
    let dir = path.join(logDir, '#' + channelName);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(logDir, { recursive: true });
    }

    switch (messageObj.subtype) {
      case void 0: {
        let text = fixupMessage(messageObj.user, messageObj.text, messageObj.upload ? messageObj.files : []);
        let { file, id } = tsToFileAndId(messageObj.ts);
        let log = await getLogFile(path.join(dir, file));
        await log.addLine(id, text);
        break;
      }
      case 'channel_join': {
        console.log('join');
        break;
      }
      case 'message_deleted': {
        let { file, id } = tsToFileAndId(messageObj.previous_message.ts);
        let log = await getLogFile(path.join(dir, file));
        await log.editLine(id, null);
        break;
      }
      case 'message_changed': {
        let text = fixupMessage(messageObj.message.user, messageObj.message.text, messageObj.message.upload ? messageObj.message.files : []);
        let { file, id } = tsToFileAndId(messageObj.previous_message.ts);
        let log = await getLogFile(path.join(dir, file));
        await log.editLine(id, text);
        break;
      }
      default: {
        console.error('unknown message type ' + messageObj.subtype);
        console.log(messageObj);
      }
    }
    if (messageObj.upload) {
      // todo save them. maybe in background?
    }


  }

  await fs.promises.mkdir(logDir, { recursive: true });


  let users = await collectAsyncIterable(
    getPaginated(Slack.users.list, { token: botToken }, res => res.members)
  );
  let userMap = new Map;
  for (let user of users) {
    userMap.set(user.id, user.real_name);
  }

  let channels = await collectAsyncIterable(
    getPaginated(Slack.conversations.list, { token: botToken }, res => res.channels)
  );
  let channelMap = new Map;
  await Promise.all(
    channels
      .map(async c => {
        channelMap.set(c.id, c.name);
        if (!c.is_member) {
          return;
          // await Slack.channels.invite({ token: oauthToken, channel: c.id, user: botUserId });
        }
        if (c.name !== 'foo') return; // todo
        let dir = path.join(logDir, '#' + c.name);
        await fs.promises.mkdir(dir, { recursive: true });
        let oldest = '1000000000.000000'; // the API complains if you give it time 0
        let files = (await fs.promises.readdir(dir)).filter(f => /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.txt$/.test(f));
        if (files.length > 0) {
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
          date.setMonth(month);
          date.setDate(day);
          let latestLog = await getLogFile(path.join(dir, latestFile));
          let keys = [...latestLog.lines.keys()];
          if (keys.length > 0) {
            let latestKey = keys[keys.length - 1];
            // this is the worst
            let [whole, part] = latestKey.split('.');
            let [hour, minute, second] = whole.split(':').map(p => +p);
            date.setHours(hour);
            date.setMinutes(minute);
            date.setSeconds(second);
            oldest = Math.floor(+date / 1000).toString() + '.' + part;
          } else {
            // file is empty (which doesn't happen in normal practice); use the oldest time on that date
            date.setHours(0);
            date.setMinutes(0);
            date.setSeconds(0);
            oldest = Math.floor(+date / 1000).toString() + '.000000';
          }
        }
        let iter = getPaginated(
          Slack.conversations.history,
          { token: oauthToken, channel: c.id, oldest, limit: 2 }, // adding 'inclusive: false' makes this inclusive. defaults to inclusive. wat.
          r => r.messages.sort((a, b) => +a.ts - +b.ts), // pages are oldest-first, but messages within a page are newest-first
        );
        for await (let historyItem of iter) {
          // order matters; Promise.all would not be appropriate (or helpful, since logs lock)
          await saveMessage(c.name, historyItem);
        }
      })
  );


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
  ws.on('message', async m => {
    try {
      m = JSON.parse(m);
      if (ignoredMessageTypes.has(m.type)) {
        return;
      }
      // TODO write to disk
      if (loggedMessageTypes.has(m.type)) {
        return;
      }

      switch (m.type) {
        // todo edits
        case 'channel_created': {
          channelMap.set(m.channel.id, m.channel.name);
          await Slack.channels.invite({ token: oauthToken, channel: m.channel.id, user: botUserId });
          break;
        }
        default: {
          console.log('got message');
          if (!channelMap.has(m.channel)) {
            console.error('missing channel info for ' + m.channel);
            return;
          }
          await saveMessage(channelMap.get(m.channel), m);
        }
      }
    } catch (e) {
      console.error(e);
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