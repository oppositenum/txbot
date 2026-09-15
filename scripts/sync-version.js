const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const file = path.join(__dirname, '..', 'web', 'index.html');
let html = fs.readFileSync(file, 'utf8');
html = html.replace(/txbot \/ 天下托管 · v[^<]+/, `txbot / 天下托管 · v${pkg.version}`);
fs.writeFileSync(file, html);
