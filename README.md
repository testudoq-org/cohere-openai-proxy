# cohere-openai-proxy

Development commands

- npm run start:dev  # run server with nodemon, restarts on source changes and shows logs in CLI
- npm run dev:logs   # run server in foreground without restart
- npm run dev:watch  # alias for start:dev (nodemon)

PM2

- npm run pm2:start  # start the app with PM2 using ecosystem.config.js
- npm run pm2:logs   # show PM2 logs for the app

Environment

- Ensure .env contains COHERE_API_KEY and optionally GLOBAL_RATE_LIMIT_PER_MIN (default 35)

Monitoring

- Health: GET /health
- Metrics: GET /metrics
