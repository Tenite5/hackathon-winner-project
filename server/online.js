// `npm run online`: starts the room server and opens a free Cloudflare quick tunnel to it,
// so people on any network can join. No account needed; the address changes every run.
import fs from 'node:fs';
import dns from 'node:dns/promises';
import { bin, install, Tunnel } from 'cloudflared';
import { startServer, setPublicUrl } from './server.js';

const PORT = Number(process.env.PORT) || 8787;
const sleep = ms => new Promise(r => setTimeout(r, ms));

await startServer({ port: PORT, quiet: true });
console.log(`\n  CoTab server is running on this computer (ws://localhost:${PORT})`);

if (!fs.existsSync(bin)) {
  console.log('  Downloading cloudflared (one time, ~40 MB)…');
  await install(bin);
}

console.log('  Opening a public tunnel…');
const tunnel = Tunnel.quick(`http://localhost:${PORT}`);
const url = await new Promise((resolve, reject) => {
  tunnel.once('url', resolve);
  tunnel.once('exit', code => reject(new Error(`cloudflared exited (${code})`)));
});
await new Promise(resolve => tunnel.once('connected', resolve));

// New tunnel names take a few seconds to appear in public DNS. Wait until the big public
// resolvers agree, otherwise the first person to open the link can get a cached "not found".
const host = new URL(url).host;
const resolvers = ['1.1.1.1', '8.8.8.8'].map(ip => {
  const r = new dns.Resolver({ timeout: 3000, tries: 1 });
  r.setServers([ip]);
  return r;
});
const resolvesEverywhere = () => Promise.all(resolvers.map(r => r.resolve4(host))).then(() => true, () => false);
await sleep(4000);
let streak = 0;
for (let i = 0; i < 90 && streak < 3; i++) {
  streak = (await resolvesEverywhere()) ? streak + 1 : 0;
  await sleep(1000);
}
if (streak < 3) console.log('  (DNS is slow today: if the link does not open yet, wait a minute and retry.)');
setPublicUrl(url);

console.log(`
  ✓ Online at ${url}

  Invite links now work from any network. Create a room in the extension
  and use "Copy invite link". Everyone else just opens that link.

  Your own extension can keep using ws://localhost:${PORT}.
  Press Ctrl+C to stop.
`);

const stop = () => {
  tunnel.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
tunnel.on('exit', code => {
  console.log(`  The tunnel closed (${code}). Run "npm run online" again for a new link.`);
  setPublicUrl('');
});
