'use strict';

let Slack = require('slack');
let WebSocket = require('ws');

let { oauthToken, botToken, botUserId } = require('./keys.json');

let ignoredMessageTypes = new Set([
  'hello',
]);


(async () => {
  /*
    setup: list channels, find channels bot is not in, invite bot to those
    then for each channel the bot is in, find previous message, delta from previous stored message, archive those between
    then go!
  */

  let channels = collectAsyncIterable(
    getPaginated(Slack.conversations.list, { token: botToken }, res => res.channels)
  );
  await Promise.all(
    channels
      .filter(c => !c.is_member)
      .map(c => Slack.channels.invite({ token: oauthToken, channel: c.id, user: botUserId }))
  );


  return;


  let result = await Slack.rtm.connect({ token: botToken });
  let rtmURL = result.url;
  let ws = new WebSocket(rtmURL);
  ws.on('open', () => {
    console.log('opened!');
  });
  ws.on('message', async m => {
    try {
      m = JSON.parse(m);
      if (ignoredMessageTypes.has(m.type)) {
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