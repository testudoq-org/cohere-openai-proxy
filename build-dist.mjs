import fs from 'fs';
import path from 'path';

const files = ['src/index.mjs', 'src/ramDocumentManager.mjs', 'src/ragDocumentManager.mjs', 'src/conversationManager.mjs', 'package.json'];
const args = process.argv.slice(2).map(a => a.toLowerCase());
const targets = [];
if (args.includes('--prod')) targets.push('dist/prod');
if (args.includes('--dev')) targets.push('dist/dev');
if (targets.length === 0) targets.push('dist/dev', 'dist/prod');
const rootPkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const makeDistPkg = (isProd = false) => ({ name: rootPkg.name, version: rootPkg.version, main: 'index.mjs', dependencies: rootPkg.dependencies, scripts: { start: isProd ? 'node index.mjs' : (rootPkg.scripts && rootPkg.scripts.start) || 'node index.mjs' } });

for (const dist of targets) {
  const isProd = dist.endsWith('prod');
  if (!fs.existsSync(dist)) fs.mkdirSync(dist, { recursive: true });
  // copy src files
  fs.cpSync('src', path.join(dist, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'package.json'), JSON.stringify(makeDistPkg(isProd), null, 2), 'utf8');
  console.log(`Built ${dist}`);
}
