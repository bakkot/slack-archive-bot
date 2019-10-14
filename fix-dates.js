'use strict';

let fs = require('fs');
let exec = require('child_process').execSync;

for (let dir of fs.readdirSync('logs')) {
  if (fs.lstatSync('logs/' + dir).isDirectory()) {
    for (let file of fs.readdirSync('logs/' + dir)) {
      if (file.endsWith('.txt')) {
        let [y, m, d] = file.split('-');
        let fixed = `${y}-${(+m) + 1}-${d}.tmp`;
        exec(`mv logs/${dir}/${file} logs/${dir}/${fixed}`, { stdio: 'inherit' });
      }
    }
  }
}

for (let dir of fs.readdirSync('logs')) {
  if (fs.lstatSync('logs/' + dir).isDirectory()) {
    for (let file of fs.readdirSync('logs/' + dir)) {
      if (file.endsWith('.txt.tmp')) {
        let fixed = file.replace(/\.tmp$/, '');
        exec(`mv logs/${dir}/${file} logs/${dir}/${fixed}`, { stdio: 'inherit' });
      }
    }
  }
}
