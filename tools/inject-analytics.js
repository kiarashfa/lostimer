/* ============================================
   LOSTimer — tools/inject-analytics.js

   Inserts ONE ID-free analytics line before </head> in every HTML page:

       <script async src="analytics.js"></script>

   The measurement ID lives only in /analytics.js. This script is idempotent:
   pages that already carry the line are skipped, so it is safe to re-run
   after adding a new page.

   Usage:  node tools/inject-analytics.js
   ============================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TAG = '<script async src="analytics.js"></script>';
const SKIP_DIRS = new Set(['.git', 'node_modules', 'fonts', 'soundfx', 'tools']);

function htmlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : htmlFiles(full);
    return e.isFile() && e.name.endsWith('.html') ? [full] : [];
  });
}

let added = 0;
let skipped = 0;

for (const file of htmlFiles(ROOT)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const src = fs.readFileSync(file, 'utf8');

  if (src.includes(TAG)) {
    console.log(`skip  ${rel} (already tagged)`);
    skipped++;
    continue;
  }
  if (!src.includes('</head>')) {
    console.log(`skip  ${rel} (no </head>)`);
    skipped++;
    continue;
  }

  const out = src.replace(
    '</head>',
    `\n  <!-- Google Analytics — measurement ID lives only in analytics.js -->\n  ${TAG}\n</head>`
  );
  fs.writeFileSync(file, out);
  console.log(`add   ${rel}`);
  added++;
}

console.log(`\n${added} page(s) tagged, ${skipped} skipped.`);
