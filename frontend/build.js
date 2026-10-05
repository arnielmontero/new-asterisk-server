'use strict';
// Bundles the SPA (SIP.js + socket.io-client + app code) into dist/ for Nginx.
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const dist = path.join(__dirname, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'src', 'main.js')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2020', 'chrome100', 'firefox100', 'safari15'],
    outfile: path.join(dist, 'app.js'),
    logLevel: 'info',
    legalComments: 'none',
  })
  .then(() => {
    for (const f of ['index.html', 'styles.css']) fs.copyFileSync(path.join(__dirname, 'src', f), path.join(dist, f));
    console.log('frontend built ->', dist);
  })
  .catch(() => process.exit(1));
