# Multi-Turn Conversation Enhancement Plan (v2)

## Objective
Enable true multi-turn conversations between Roo and Cohere AI by maintaining and utilizing conversation history, associating sessions with users, and integrating existing helper functions for message formatting and truncation.

---

## 1. In-Memory Session Store

- Add an in-memory object (e.g., `this.sessions = {}`) to the `CohereProxyServer` class.
- Each session key is a `sessionId` (provided by the client or generated if missing).
- Each session value is an array of message objects (user/assistant turns).

---

## 2. Chat Endpoint Refactor

- Update the `/v1/chat/completions` endpoint to:
  - Accept a `sessionId` in the request body.
  - Retrieve the conversation history for the session (or initialize if new).
  - Append the new user message to the session history.
  - Use `formatMessagesForCohereChat` and `intelligentTruncateMessages` to prepare the message array.
  - Send the formatted, truncated history to Cohere.
  - Store the assistant’s reply in the session history.
  - Return `{ sessionId, messages, reply }` in the response.

- **Restrict multi-turn session logic to chat-capable models only** (e.g., command-r, command-r-plus).

---

## 3. Robust Session & Error Handling

- Handle new sessions (initialize history).
- Handle expired/invalid sessions (optionally implement TTL or cleanup).
- Gracefully handle API and formatting errors.

---

## 4. Documentation & Examples

- Update usage docs to show the new request/response format.
- Provide example payloads for multi-turn usage.

---

## 5. (Optional) Mermaid Diagram

```mermaid
sequenceDiagram
    participant Client
    participant Proxy
    participant SessionStore
    participant Cohere

    Client->>Proxy: POST /v1/chat/completions {sessionId, message}
    Proxy->>SessionStore: Retrieve history for sessionId
    SessionStore-->>Proxy: Message history (or empty)
    Proxy->>SessionStore: Append user message
    Proxy->>Cohere: Send formatted, truncated history
    Cohere-->>Proxy: Assistant reply
    Proxy->>SessionStore: Append assistant reply
    Proxy->>Client: {sessionId, messages, reply}
```

---

## Summary

- In-memory session storage will be used for conversation history.
- Multi-turn session logic will be restricted to chat-capable models.
- The chat endpoint will be refactored to accept a session/user ID, manage conversation history, and use the provided helper functions for formatting and truncation.
- The API response will include the sessionId, updated messages, and the latest reply.
- Robust error handling and updated documentation will be included.
- A Mermaid diagram illustrates the new flow.