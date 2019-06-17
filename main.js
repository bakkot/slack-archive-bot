'use strict';

let Slack = require('slack');
let WebSocket = require('ws');

let { oauthToken, botToken, botUserId } = require('./keys.json');

// things we _actually_ ignore
let ignoredMessageTypes = new Set([
  'hello',
  'user_typing',
]);

// things we handle only by logging the event to disk
let loggedMessageTypes = new Set([
  'file_shared',
  'file_public',
]);

/*
TODO;

actually log things
handle channel renames
handle files - append <attached file 'ts-name.ext'>, and save file to disk
  probably in distinct "files" directory
write non-ignored events to disk

*/


(async () => {
  /*
    setup: list channels, find channels bot is not in, invite bot to those
    then for each channel the bot is in, find previous message, delta from previous stored message, archive those between
    then go!
  */

  // let channels = collectAsyncIterable(
  //   getPaginated(Slack.conversations.list, { token: botToken }, res => res.channels)
  // );
  // await Promise.all(
  //   channels
  //     .filter(c => !c.is_member)
  //     .map(c => Slack.channels.invite({ token: oauthToken, channel: c.id, user: botUserId }))
  // );


  // return;


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
        case 'channel_created': {
          await Slack.channels.invite({ token: oauthToken, channel: m.channel.id, user: botUserId });
          break;
        }
        default: {
          console.log('message');
          console.log(m);
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
  cursor = result.response_metadata.next_cursor;
  while (cursor) {
    result = await method({ limit, ...opts, cursor: next_cursor });
    yield* getList(result);
    cursor = result.response_metadata.next_cursor;
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