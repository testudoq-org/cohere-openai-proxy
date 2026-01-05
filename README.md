# Cohere OpenAI Proxy

Quick curl examples (Windows CMD):

- Chat (CMD):
  curl -i -X POST "http://localhost:3000/chat/completions" -H "Content-Type: application/json" -d "{\"messages\":[{\"role\":\"user\",\"content\":\"What is a firewall?\"}]}"

- Embed (CMD):
  curl -i -X POST "http://localhost:3000/v1/embed" -H "Content-Type: application/json" -d "{\"input\":\"test embedding\",\"model\":\"embed-english-v3.0\"}"

PowerShell examples (for convenience):

- Chat (PowerShell):
  curl -i -Method POST "http://localhost:3000/chat/completions" -Headers @{"Content-Type"="application/json"} -Body ('{"messages":[{"role":"user","content":"What is a firewall?"}]}')

- Embed (PowerShell):
  curl -i -Method POST "http://localhost:3000/v1/embed" -Headers @{"Content-Type"="application/json"} -Body ('{"input":"test embedding","model":"embed-english-v3.0"}')

Note: On Windows CMD ensure you use escaped double-quotes (\") inside the -d payload; on PowerShell use single-quoted string around the JSON or pass the JSON via -Body as shown.