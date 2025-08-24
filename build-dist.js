// build-dist.js
// Node.js script to prepare dist/dev and/or dist/prod with required files and full package.json (dependencies + start script)

const fs = require('fs');
const path = require('path');

const files = ['index.js', 'memoryCache.js', 'ragDocumentManager.js', 'conversationManager.js', 'scripts/verify-dist.sh'];
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
/**
 * Always set the start script to "node index.js" for production builds
 * to ensure Docker compatibility and avoid memory flags.
 */
const makeDistPkg = (isProd = false) => ({
  name: rootPkg.name,
  version: rootPkg.version,
  main: rootPkg.main,
  description: rootPkg.description || "",
  license: rootPkg.license || "",
  author: rootPkg.author || "",
  dependencies: rootPkg.dependencies,
  scripts: {
    start: isProd
      ? "node index.js"
      : (rootPkg.scripts && rootPkg.scripts.start
        ? rootPkg.scripts.start
        : "node index.js")
  }
});

for (const dist of targets) {
  const isProd = dist === 'dist/prod';
  if (!fs.existsSync(dist)) {
    fs.mkdirSync(dist, { recursive: true });
  }
  for (const file of files) {
    const dest = path.join(dist, file);
    const destDir = path.dirname(dest);
    // Ensure destination directory exists for nested files (e.g. scripts/...)
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(file, dest);
    // If we're copying a script, try to preserve executable bit (best-effort on Windows)
    if (file.startsWith('scripts/') && process.platform !== 'win32') {
      try {
        fs.chmodSync(dest, 0o755);
      } catch (e) {
        // Non-fatal if chmod is not supported
      }
    }
  }
  fs.writeFileSync(
    path.join(dist, 'package.json'),
    JSON.stringify(makeDistPkg(isProd), null, 2),
    'utf8'
  );
  console.log(`Built ${dist} with required files and full package.json.`);
}

if (targets.length === 2) {
  console.log('dist/dev and dist/prod are ready.');
}