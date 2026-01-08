# PowerShell repro for Windows
$RouterBase = $env:ROUTER_BASE -or 'http://localhost:3000'
$Model = $env:MODEL -or 'command-a-vision-07-2025'

$Payload = @{
    messages = @(@{ role = 'user'; content = 'What is a firewall?' })
    model = $Model
} | ConvertTo-Json -Depth 5

Write-Host "POST $RouterBase/chat/completions with model=$Model"
Invoke-RestMethod -Uri "$RouterBase/chat/completions" -Method Post -ContentType 'application/json' -Body $Payload -ErrorAction Stop

# Try alias model
$Model = 'command-r'
$Payload = @{
    messages = @(@{ role = 'user'; content = 'What is a firewall?' })
    model = $Model
} | ConvertTo-Json -Depth 5

Write-Host "`nPOST $RouterBase/chat/completions with model=$Model"
Invoke-RestMethod -Uri "$RouterBase/chat/completions" -Method Post -ContentType 'application/json' -Body $Payload -ErrorAction Stop
