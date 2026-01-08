module.exports = {
  apps: [
    {
      name: 'cohere-openai-proxy',
      script: 'src/index.mjs',
      interpreter: 'node',
      interpreter_args: '--enable-source-maps --trace-warnings',
      watch: false,
      env: {
        NODE_ENV: 'production'
      },
      env_development: {
        NODE_ENV: 'development'
      }
    }
  ]
};
