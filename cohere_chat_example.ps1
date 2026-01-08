$env:COHERE_API_KEY = 'vnjEEAuIDziGugme4bZdvRZtk4vTAUwfRwZbxQNF'
$body = @{ stream = $false; model = 'command-a-vision-07-2025'; messages = @(@{ role = 'user'; content = 'What is a firewall?' }) } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri 'https://api.cohere.com/v2/chat' -Method Post -Headers @{ Authorization = "Bearer $env:COHERE_API_KEY"; 'Content-Type' = 'application/json' } -Body $body
