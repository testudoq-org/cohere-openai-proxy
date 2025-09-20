# Production Deployment Structure (MIGRATED — OUTDATED)

This document previously described a legacy CommonJS layout. The repository has been migrated to ES Modules (ESM). The canonical runtime is now under `src/` and build outputs are produced by `build-dist.mjs` into `dist/prod`.

All application files should reside in `/cop` on the production webhost.

**Directory layout (ESM):**
```
/cop/
  src/index.mjs
  src/ragDocumentManager.mjs
  src/conversationManager.mjs
  package.json
  node_modules/   (symlink or actual directory)
  .env            (your environment variables)
```

- Use the `build-dist.mjs` script to prepare the files for deployment (creates `dist/prod`).
- Copy the contents of `dist/prod` to `/cop` on your production server.
- Ensure `node_modules` is present in `/cop` (can be a symlink to a shared location).
- Place your `.env` file in `/cop` with the required environment variables.

**For Docker deployments:**
Do not copy `.env` into the image. Instead, inject environment variables at runtime using:
```sh
docker run --env-file .env <image-name>
```
This ensures your environment variables are available and avoids issues with `.dockerignore` or missing files at build time.

**Start the application:**
```sh
cd /cop
npm start
```
Set the COHERE_MODEL environment variable (default: command-a-reasoning-08-2025) to control which Cohere model is used.