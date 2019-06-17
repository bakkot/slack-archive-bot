# WIP

## `keys.json`

You must provide a `keys.json`. It should be an object with the following keys:
- `"oauthToken"`, from https://api.slack.com/apps/whatever
- `"botToken"`, from same
- `"client_id"`, from same
- `"client_secret"`, from same
- `"team"` from running `boot_data.team_id` in the console on the workspace page
- `"botUserId"`, from running `require('slack').users.list({ token: oauthToken }, console.log)` in node

It _may_ also need `"userToken"`, the value for which you can obtain by running `auth.js` after filling out the above.


## Caveats

If you post a message, then the archive bot goes offline, then you edit your message, the edit will not be captured.
