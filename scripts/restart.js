#!/usr/bin/env node
// Restart Quant Terminal: stop the copy running from this folder, then start it again.
//   node scripts/restart.js            node scripts/restart.js --no-open
// The desktop "Restart Quant Terminal" shortcut runs this.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const first = Number(process.env.PORT) || 3777;
const same = (a, b) => !!a && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(700) });
    const j = await r.json();
    // Only this folder's copy counts; another install on the same port range is left alone.
    return j.app === 'quant-terminal' && same(j.root, root) ? j : null;
  } catch { return null; }
}

let port = null;
for (let p = first; p < first + 21 && !port; p++) if (await health(p)) port = p;

if (port) {
  await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { 'x-qt': '1' } }).catch(() => {});
  // launch.js skips starting a server when one already answers, so wait for this one to go.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && (await health(port))) await new Promise((r) => setTimeout(r, 250));
  console.log(`Stopped Quant Terminal on port ${port}`);
} else {
  console.log('Quant Terminal was not running from this folder.');
}

// launch.js starts it again (or for the first time) and opens the browser.
const child = spawn(process.execPath, [path.join(root, 'scripts', 'launch.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(await new Promise((r) => child.on('exit', (code) => r(code ?? 0))));
