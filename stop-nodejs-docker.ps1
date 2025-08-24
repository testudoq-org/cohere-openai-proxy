# stop-nodejs-docker.ps1
# Script to stop and remove the Node.js Docker container.
# Uses a variable for the container name (default: "cohere-app").

# Set the container name (change if needed)
$containerName = "cohere-app"

Write-Host "Checking if container '$containerName' exists..."

# Check if the container exists
$containerExists = docker ps -a --format "{{.Names}}" | Select-String -Pattern "^$containerName$"

if ($containerExists) {
    Write-Host "Stopping container '$containerName'..."
    docker stop $containerName | Out-Null

    Write-Host "Removing container '$containerName'..."
    docker rm $containerName | Out-Null

    Write-Host "Container '$containerName' stopped and removed."
} else {
    Write-Host "Container '$containerName' does not exist. Nothing to stop or remove."
}