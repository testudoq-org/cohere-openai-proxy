# Dockerfile for Cohere Proxy Server

FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy source code
COPY . .

# Expose port (default 3000, can be overridden by env)
EXPOSE 3000

# Set environment variables (can be overridden at runtime)
ENV NODE_ENV=production

# Start the server
CMD ["node", "index.js"]