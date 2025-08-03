#!/bin/bash
# Automated setup script for Cohere Proxy Server (Linux/macOS) with port selection

echo "== Cohere Proxy Server Automated Setup =="

# Check for Node.js
if ! command -v node &> /dev/null
then
    echo "Node.js is not installed. Please install Node.js 16+ and rerun this script."
    exit 1
fi

# Install dependencies
echo "Installing dependencies..."
npm install

# Check for .env file
if [ ! -f .env ]; then
    echo "No .env file found. Creating a template .env file."
    cat <<EOT > .env
COHERE_API_KEY=your_cohere_api_key_here
PORT=3000
ALLOWED_ORIGINS=http://localhost:3000
EOT
    echo "Please edit the .env file to add your Cohere API key."
fi

# Automated port selection
PORT=$(grep "^PORT=" .env | cut -d'=' -f2)
if [ -z "$PORT" ]; then
    PORT=3000
fi

while lsof -i :$PORT >/dev/null 2>&1; do
    echo "Port $PORT is in use, trying next..."
    PORT=$((PORT+1))
done

# Update .env with selected port
if grep -q "^PORT=" .env; then
    sed -i.bak "s/^PORT=.*/PORT=$PORT/" .env
else
    echo "PORT=$PORT" >> .env
fi

echo "Using port $PORT"

# Start the server
echo "Starting the server..."
node index.js