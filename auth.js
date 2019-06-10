'use strict';

let readline = require('readline');
let slack = require('slack');

let { client_id, client_secret, team } = require('./keys.json');

// from https://api.slack.com/docs/oauth-scopes
let scopes = ['users:read', 'channels:history', 'channels:read', 'channels:write' /* to invite the bot */].join(',');

// doesn't matter, just needs to be made available in https://api.slack.com/apps/whatever/oauth
let redirect_uri = 'https://example.com';

(async () => {
  console.log(`Please visit:
https://slack.com/oauth/?client_id=${encodeURIComponent(client_id)}&scope=${encodeURIComponent(scopes)}&team=${encodeURIComponent(team)}&redirect_uri=${encodeURIComponent(redirect_uri)}

and auth, then paste the resulting example.com url here.`);

  let url = await askQuestion('redirect url:\n');
  let code = new URL(url).searchParams.get('code');
  console.log('Code:')
  console.log(code);

  let result = await slack.oauth.access({ client_id, client_secret, code });
  console.log('result:')
  console.log(result);
  console.log('the token from that:');
  console.log(result.access_token);
})();


function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}
