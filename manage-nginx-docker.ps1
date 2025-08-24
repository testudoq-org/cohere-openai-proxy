# PowerShell Script: manage-nginx-docker.ps1
# Automates Docker container lifecycle and health monitoring for a specified image (default: nginx:latest)
# Author: Roo
# Date: 2025-08-23

# =========================
# Configuration Variables
# =========================

$ImageName = "nginx:latest"                # Docker image to use
$ContainerName = "nginx-managed"           # Name for the Docker container
$HealthCheckIntervalSeconds = 10           # Interval between health checks (seconds)
$MaxConsecutiveFailures = 3                # Max allowed consecutive health check failures
$LogFile = "manage-nginx-docker.log"       # Log file path

# =========================
# Utility Functions
# =========================

function Write-Log {
    param (
        [string]$Message
    )
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] $Message"
    Write-Host $logEntry
    Add-Content -Path $LogFile -Value $logEntry
}

# =========================
# Pre-Checks
# =========================

Write-Log "Starting manage-nginx-docker.ps1 script."

# Check if Docker is installed
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Log "Docker is not installed. Exiting."
    exit 1
}

# Check if Docker daemon is running
try {
    docker info | Out-Null
} catch {
    Write-Log "Docker daemon is not running. Exiting."
    exit 1
}

Write-Log "Docker is installed and running."

# Check if port 80 is available
$port80InUse = Get-NetTCPConnection -LocalPort 80 -ErrorAction SilentlyContinue | Where-Object { $_.State -eq "Listen" }
if ($port80InUse) {
    Write-Log "Port 80 is already in use. Exiting."
    exit 1
}

Write-Log "Port 80 is available."

# =========================
# Pull Docker Image
# =========================

Write-Log "Pulling Docker image '$ImageName'."
try {
    docker pull $ImageName | Out-Null
    Write-Log "Successfully pulled image '$ImageName'."
} catch {
    Write-Log "Failed to pull image '$ImageName'. Exiting."
    exit 1
}

# =========================
# Run Docker Container
# =========================

Write-Log "Running container '$ContainerName' from image '$ImageName'."
try {
    # Remove any existing container with the same name
    $existingContainer = docker ps -a --filter "name=$ContainerName" --format "{{.ID}}"
    if ($existingContainer) {
        Write-Log "Removing existing container '$ContainerName'."
        docker stop $ContainerName | Out-Null
        docker rm $ContainerName | Out-Null
    }

    # Run new container
    docker run -d --name $ContainerName -p 80:80 $ImageName | Out-Null
    Write-Log "Container '$ContainerName' started and mapped to port 80."
} catch {
    Write-Log "Failed to start container '$ContainerName'. Exiting."
    exit 1
}

# =========================
# Health Check Loop
# =========================

$failureCount = 0
Write-Log "Starting health check loop (interval: $HealthCheckIntervalSeconds seconds, max failures: $MaxConsecutiveFailures)."

while ($true) {
    Start-Sleep -Seconds $HealthCheckIntervalSeconds

    try {
        $response = Invoke-WebRequest -Uri "http://localhost:80" -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -eq 200) {
            Write-Log "Health check passed (HTTP 200)."
            $failureCount = 0
        } else {
            Write-Log "Health check failed (HTTP $($response.StatusCode))."
            $failureCount++
        }
    } catch {
        Write-Log "Health check failed (network error or no response)."
        $failureCount++
    }

    if ($failureCount -ge $MaxConsecutiveFailures) {
        Write-Log "Health check failed $failureCount times consecutively. Stopping and removing container."
        try {
            docker stop $ContainerName | Out-Null
            docker rm $ContainerName | Out-Null
            Write-Log "Container '$ContainerName' stopped and removed due to health check failures."
        } catch {
            Write-Log "Error during container cleanup."
        }
        break
    }
}

Write-Log "Script completed. Cleanup done."