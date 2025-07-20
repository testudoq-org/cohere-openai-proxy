# Cohere Proxy Server

A production-ready Express.js server that acts as a proxy between OpenAI-compatible chat completion requests and Cohere's API. This allows applications built for OpenAI's Chat Completions API to seamlessly work with Cohere's language models without requiring any client-side code changes.

## 🌟 Features

- **OpenAI API Compatibility**: Full compatibility with OpenAI's Chat Completions API format
- **Production Ready**: Built-in security, rate limiting, and error handling
- **Multi-Model Support**: Support for various Cohere models (Command-R, Command-R+, etc.)
- **Monitoring & Logging**: Health checks, request logging, and performance metrics
- **Security First**: Rate limiting, CORS protection, input validation, and security headers
- **Easy Migration**: Drop-in replacement for OpenAI API endpoints

## 🚀 Quick Start

### Prerequisites

- Node.js 16+ and npm
- A Cohere API key ([get one here](https://dashboard.cohere.ai/))

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd cohere-proxy-server
```

2. Install dependencies:
```bash
npm install express dotenv cors cohere-ai express-rate-limit helmet morgan
```

3. Create a `.env` file:
```env
COHERE_API_KEY=your_cohere_api_key_here
PORT=3000
ALLOWED_ORIGINS=http://localhost:3000,https://yourdomain.com
```

4. Start the server:
```bash
node server.js
```

The server will be running at `http://localhost:3000`

## 📖 Usage

### Health Check

```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2025-07-20T12:00:00.000Z",
  "uptime": 123.45
}
```

### Chat Completions

Send a POST request to `/v1/chat/completions` with OpenAI-compatible format:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello! How are you?"}
    ],
    "temperature": 0.7,
    "max_tokens": 300
  }'
```

Response:
```json
{
  "id": "chatcmpl-1642684800000abc123",
  "object": "chat.completion",
  "created": 1642684800,
  "model": "cohere/command-r",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! I'm doing well, thank you for asking. How can I help you today?"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 23,
    "completion_tokens": 17,
    "total_tokens": 40
  },
  "system_fingerprint": "cohere_command-r_1642684800000",
  "processing_time_ms": 1250
}
```

### JavaScript Example

```javascript
const response = await fetch('http://localhost:3000/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Explain quantum computing in simple terms.' }
    ],
    temperature: 0.7,
    max_tokens: 500
  })
});

const data = await response.json();
console.log(data.choices[0].message.content);
```

## ⚙️ Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `COHERE_API_KEY` | ✅ | - | Your Cohere API key |
| `PORT` | ❌ | `3000` | Server port |
| `ALLOWED_ORIGINS` | ❌ | `*` | Comma-separated CORS origins |

### Supported Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|--------|-------------|
| `messages` | Array | - | - | Chat messages in OpenAI format |
| `temperature` | Number | `0.7` | `0-2` | Sampling temperature |
| `max_tokens` | Number | `300` | `1-4096` | Maximum tokens to generate |
| `model` | String | `command-r` | - | Cohere model to use |

### Supported Models

- `command-r` - Latest Command-R model
- `command-r-plus` - Enhanced Command-R model
- `command` - Standard Command model
- `command-nightly` - Nightly Command model
- `command-light` - Lightweight Command model
- `command-light-nightly` - Nightly lightweight model

## 🛡️ Security Features

- **Rate Limiting**: 100 requests per 15 minutes per IP
- **Security Headers**: Helmet.js protection against common vulnerabilities
- **Input Validation**: Comprehensive request validation
- **CORS Protection**: Configurable origin restrictions
- **Error Sanitization**: Safe error messages without sensitive data exposure

## 📊 Monitoring

### Health Endpoint

The `/health` endpoint provides:
- Server status
- Uptime information
- Timestamp

### Logging

The server logs:
- All HTTP requests (via Morgan)
- Error details with timestamps
- Performance metrics
- Rate limit violations

## 🔧 Development

### Running in Development

```bash
# Install nodemon for auto-restart
npm install -g nodemon

# Run with auto-restart
nodemon server.js
```

### Testing

```bash
# Test health endpoint
curl http://localhost:3000/health

# Test chat completion
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

## 🚨 Error Handling

The server returns structured error responses:

```json
{
  "error": {
    "message": "Temperature must be between 0 and 2",
    "type": "invalid_request_error",
    "timestamp": "2025-07-20T12:00:00.000Z"
  }
}
```

### Error Types

- `authentication_error` - Invalid or missing API key
- `invalid_request_error` - Invalid request parameters
- `rate_limit_exceeded` - Rate limit violation
- `internal_server_error` - Server-side errors
- `not_found` - Invalid endpoint

## 📈 Performance

### Rate Limits

- **Default**: 100 requests per 15 minutes per IP
- **Configurable**: Modify in the `setupMiddleware` method
- **Headers**: Rate limit info included in response headers

### Token Estimation

The server provides token usage estimates:
- **Prompt tokens**: Estimated from input text
- **Completion tokens**: Estimated from generated text
- **Total tokens**: Sum of prompt and completion tokens

*Note: Token estimates are approximations and may differ from Cohere's actual token counting.*

## 🐛 Troubleshooting

### Common Issues

**Server won't start:**
- Check if the port is already in use
- Verify the COHERE_API_KEY is set correctly
- Ensure all dependencies are installed

**Authentication errors:**
- Verify your Cohere API key is valid
- Check if your key has the necessary permissions
- Ensure the key is properly set in the environment

**Rate limiting issues:**
- Default limit is 100 requests per 15 minutes
- Adjust the rate limit in the code if needed
- Check if multiple clients are sharing the same IP

**CORS errors:**
- Set `ALLOWED_ORIGINS` in your `.env` file
- Use comma-separated values for multiple origins
- Use `*` to allow all origins (not recommended for production)

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/your-repo/issues)
- **Documentation**: See [ARCHITECTURE.md](ARCHITECTURE.md) for technical details
- **Cohere API**: [Cohere Documentation](https://docs.cohere.com/)

## 🔗 Related Projects

- [OpenAI API Documentation](https://platform.openai.com/docs/api-reference)
- [Cohere API Documentation](https://docs.cohere.com/docs)
- [Express.js](https://expressjs.com/)

---

**Made with ❤️ for seamless AI API integration**