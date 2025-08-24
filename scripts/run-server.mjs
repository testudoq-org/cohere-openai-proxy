import EnhancedCohereRAGServer from '../src/index.mjs';

 (async () => {
  console.log('runner: creating server instance');
  const server = new EnhancedCohereRAGServer({ port: process.env.PORT || 3000 });
  console.log('runner: calling start()');
  const startPromise = server.start();

  // watchdog
  const timeout = setTimeout(() => {
    console.error('runner: start() did not resolve within 10s, likely blocked');
    process.exit(2);
  }, 10000);

  try {
    await startPromise;
    clearTimeout(timeout);
    console.log('runner: server started successfully');
  } catch (err) {
    clearTimeout(timeout);
    console.error('runner: server failed to start:', err);
    process.exit(1);
  }
})();
