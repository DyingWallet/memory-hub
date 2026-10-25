// Patch dsh.baseUrl in config.json without touching anything else.
// Usage: node set-dsh-url.cjs <port>
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2]);
if (!port) {
  console.error('usage: node set-dsh-url.cjs <port>');
  process.exit(1);
}

const file = path.join(__dirname, 'config.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
const url = `http://127.0.0.1:${port}`;
if (cfg.dsh.baseUrl !== url) {
  cfg.dsh.baseUrl = url;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
}
console.log(cfg.dsh.baseUrl);
