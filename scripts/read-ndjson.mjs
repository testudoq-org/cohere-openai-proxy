import fsSync from 'fs';
import path from 'path';
import readline from 'readline';
import zlib from 'zlib';

const dir = path.join(process.cwd(),'test-embeddings-dir');
if (!fsSync.existsSync(dir)) { console.log('no dir'); process.exit(0); }
for (const f of fsSync.readdirSync(dir)) {
  const full = path.join(dir,f);
  console.log('FILE', f);
  if (f.endsWith('.gz')) {
    const stream = fsSync.createReadStream(full).pipe(zlib.createGunzip());
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    (async ()=>{
      for await (const line of rl) {
        console.log('LINE:', JSON.stringify(line));
        try { console.log('PARSED:', JSON.parse(line)); } catch (e) { console.log('PARSE_ERR', e.message); }
      }
    })();
  } else if (f.endsWith('.ndjson')) {
    const rl = readline.createInterface({ input: fsSync.createReadStream(full), crlfDelay: Infinity });
    (async ()=>{
      for await (const line of rl) {
        console.log('LINE:', JSON.stringify(line));
        try { console.log('PARSED:', JSON.parse(line)); } catch (e) { console.log('PARSE_ERR', e.message); }
      }
    })();
  }
}
