/*
 * (C) Copyright 2026 Hyland (http://hyland.com/) and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Contributors:
 *     Thibaud Arguillere (with the help of opencode/Claude Opus 5.5)
 */

/*
 * Shared helpers of the dev tools (NOT packaged): static HTTP server of the project, puppeteer-core loading and
 * Chrome launching. Nothing is installed by the project: point to an existing installation with
 *   LWG_NODE_MODULES  a node_modules folder containing puppeteer-core
 *   CHROME_PATH       a Chrome or chrome-headless-shell executable (default: Google Chrome on macOS)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const outDir = path.join(projectDir, 'dev', 'out');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function loadPuppeteer() {
  const dir = process.env.LWG_NODE_MODULES;
  if (!dir || !fs.existsSync(dir)) {
    throw new Error('Set LWG_NODE_MODULES to a node_modules folder containing puppeteer-core');
  }
  const require = createRequire(path.join(dir, 'noop.js'));
  return require('puppeteer-core');
}

export async function launchBrowser() {
  const puppeteer = loadPuppeteer();
  return puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox', '--font-render-hinting=none', '--force-color-profile=srgb'],
  });
}

// Serves the project directory on a random local port. Returns { server, baseUrl }.
export function startServer() {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    // requested by recent Chrome versions on the first page: answered without content, so no 404 is logged
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    const file = path.normalize(path.join(projectDir, pathname));
    if (!file.startsWith(projectDir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}
