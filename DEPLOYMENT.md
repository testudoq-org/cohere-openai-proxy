# Production Deployment Structure

All application files should reside in `/cop` on the production webhost.

**Directory layout:**
```
/cop/
  index.js
  memoryCache.js
  ragDocumentManager.js
  conversationManager.js
  package.json
  node_modules/   (symlink or actual directory)
  .env            (your environment variables)
```

- Use the `build-dist.sh` script to prepare the files for deployment.
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