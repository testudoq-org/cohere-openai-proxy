# syntax=docker/dockerfile:1

# Use minimal Node.js Alpine image for smaller, secure builds
FROM node:20-alpine

# Set working directory to /app (best practice for Node.js apps)
WORKDIR /app

# Copy package metadata first to leverage Docker layer caching for npm install
# Only copy package files from the dist/prod build output.
COPY dist/prod/package.json dist/prod/package-lock.json ./

# Install only production dependencies for security and efficiency
RUN npm ci --only=production

# Copy the rest of the application files from dist/prod into the image
# Use --chown to ensure files are owned by the non-root node user in the final image
COPY --chown=node:node dist/prod/ ./

# Build-time verification: output environment and list files copied to /app so it's visible in build logs
RUN node -v || true
RUN npm -v || true
RUN echo "--- /app contents ---" && ls -la /app || true

# Fail fast if required runtime files are missing
RUN (for f in src/index.mjs src/ragDocumentManager.mjs src/conversationManager.mjs src/utils/lruTtlCache.mjs package.json; do \
			if [ ! -f "/app/$f" ]; then echo "[BUILD ERROR] Missing required file: /app/$f" >&2; exit 2; fi; \
		done) \
		&& echo "[BUILD OK] All required runtime files present."

# If a .env was generated into dist/prod (not recommended), keep it but do not fail if missing
RUN if [ -f ./.env ]; then echo ".env present in image (consider mounting at runtime instead)"; fi || true

# Ensure correct ownership (defensive)
RUN chown -R node:node /app || true


# Non-blocking container healthcheck: call the /health endpoint using node (no extra packages)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e 'const http=require("http"); const req=http.get("http://localhost:3000/health",res=>{process.exit(res.statusCode===200?0:1)}); req.on("error",()=>process.exit(1));'

# Switch to non-root user
USER node

# Expose port 3000 for application traffic
EXPOSE 3000

# Start the app directly using the ESM entry (src/index.mjs)
# Using node directly avoids relying on a root index.js and works with the dist/prod layout created by build-dist.mjs
CMD ["node", "src/index.mjs"]

# --- Notes ---
# - We copy package.json first so `npm ci` uses Docker cache when dependencies don't change
# - We then copy the full dist/prod directory to ensure every runtime file is present
# - Avoid copying source files or secrets into the image; mount .env at runtime or use --env-file