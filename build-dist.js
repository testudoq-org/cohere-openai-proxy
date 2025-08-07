// build-dist.js
// Node.js script to prepare dist/dev and/or dist/prod with required files and full package.json (dependencies + start script)

const fs = require('fs');
const path = require('path');

const files = ['index.js', 'memoryCache.js', 'ragDocumentManager.js', 'conversationManager.js'];
const args = process.argv.slice(2).map(arg => arg.toLowerCase());
let targets = [];

if (args.includes('--prod')) {
  targets.push('dist/prod');
}
if (args.includes('--dev')) {
  targets.push('dist/dev');
}
if (targets.length === 0) {
  targets = ['dist/dev', 'dist/prod'];
}

// Read root package.json
const rootPkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

// Prepare new package.json: keep name, version, main, description, dependencies, and only the start script
const makeDistPkg = () => ({
  name: rootPkg.name,
  version: rootPkg.version,
  main: rootPkg.main,
  description: rootPkg.description || "",
  license: rootPkg.license || "",
  author: rootPkg.author || "",
  dependencies: rootPkg.dependencies,
  scripts: {
    start: rootPkg.scripts.start
  }
});

for (const dist of targets) {
  if (!fs.existsSync(dist)) {
    fs.mkdirSync(dist, { recursive: true });
  }
  for (const file of files) {
    fs.copyFileSync(file, path.join(dist, file));
  }
  fs.writeFileSync(
    path.join(dist, 'package.json'),
    JSON.stringify(makeDistPkg(), null, 2),
    'utf8'
  );
  console.log(`Built ${dist} with required files and full package.json.`);
}

if (targets.length === 2) {
  console.log('dist/dev and dist/prod are ready.');
}