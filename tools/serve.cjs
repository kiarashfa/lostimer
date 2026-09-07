/* ============================================
   LOSTimer — tools/serve.cjs

   Local preview server. Serves the repo under the same base path GitHub
   Pages uses, so base-path mistakes show up locally instead of in production:

       http://localhost:4173/LOSTimer/

   It also serves 404.html (with a real 404 status) for missing paths, and
   accepts POST /__save?name=<repo-relative path> to write a binary body to
   disk — that is how tools/og-generate.html saves the social images.

   Usage:  node tools/serve.cjs
   Dev-only. Nothing here ships to visitors.
   ============================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = path.resolve(__dirname, '..');
const BASE = '/LOSTimer';
const PORT = 4173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8'
};

http.createServer((req, res) => {
  const u = url.parse(req.url, true);

  if (req.method === 'POST' && u.pathname.endsWith('/__save')) {
    const name = u.query.name;
    if (!name || !/^[A-Za-z0-9._\-/]+$/.test(name) || name.indexOf('..') !== -1) {
      res.writeHead(400);
      return res.end('bad name');
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const out = path.join(ROOT, name);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, body);
      console.log('WROTE ' + name + ' (' + body.length + ' bytes)');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok ' + body.length + ' bytes');
    });
    return;
  }

  let p = decodeURIComponent(u.pathname);
  if (p.indexOf(BASE) === 0) p = p.slice(BASE.length);
  if (p === '' || p === '/') p = '/index.html';

  const file = path.join(ROOT, p);
  if (file.indexOf(ROOT) !== 0) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const nf = path.join(ROOT, '404.html');
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.existsSync(nf) ? fs.readFileSync(nf) : 'not found');
  }

  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log('LOSTimer preview: http://localhost:' + PORT + BASE + '/');
});
