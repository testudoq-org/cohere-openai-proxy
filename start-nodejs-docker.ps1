# Enhanced PowerShell script for Docker management
param(
    [string]$Mode = "prod",
    [string]$Action = "run",
    [switch]$Rebuild
)

# Configuration
$imageName = "cohere-app"
$containerName = "cohere-app"
$hostPort = 3000
$containerPort = 3000

Write-Host "=== Enhanced Cohere Proxy Docker Management ===" -ForegroundColor Green
Write-Host "Mode: $Mode | Action: $Action" -ForegroundColor Cyan

# Validate mode
if ($Mode -notin @("dev", "prod")) {
    Write-Error "Invalid mode. Use 'dev' or 'prod'"
    exit 1
}

# Build dist/prod if in production mode
if ($Mode -eq "prod") {
    Write-Host "Building production distribution..." -ForegroundColor Yellow
    node build-dist.js --prod
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Build failed. Exiting."
        exit 1
    }
}

# Helper: run docker build but handle missing buildx when BuildKit is enabled globally.
function Run-DockerBuild {
    param(
        [string]$Tag = $imageName,
        [string]$Context = ".",
        [string]$Dockerfile = "Dockerfile"
    )

    # Preserve existing DOCKER_BUILDKIT env var
    $prevBuildKit = $env:DOCKER_BUILDKIT

    # Check if buildx is available
    & docker buildx version > $null 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Docker Buildx not available. Temporarily disabling BuildKit for this build (DOCKER_BUILDKIT=0)."
        $env:DOCKER_BUILDKIT = "0"
    } else {
        # buildx available -- ensure BuildKit stays as-is (respect user's env)
    }

    try {
        Write-Host "Building Docker image '$Tag'..." -ForegroundColor Yellow

        # Capture build output and exit code so the function returns only the numeric exit code.
        # This prevents the build log from becoming the function's output value.
        $buildOutput = & docker build -t "$Tag" -f $Dockerfile $Context 2>&1
        $buildExit = $LASTEXITCODE

        # Print captured output to the host (doesn't emit to pipeline)
        if ($buildOutput) {
            $buildOutput | ForEach-Object { Write-Host $_ }
        }
    } finally {
        # restore previous DOCKER_BUILDKIT (remove if it was not set)
        if ([string]::IsNullOrEmpty($prevBuildKit)) {
            Remove-Item Env:\DOCKER_BUILDKIT -ErrorAction SilentlyContinue
        } else {
            $env:DOCKER_BUILDKIT = $prevBuildKit
        }
    }

    return [int]$buildExit
}

switch ($Action.ToLower()) {
    "build" {
        Write-Host "Building Docker image..." -ForegroundColor Yellow
        $exitCode = Run-DockerBuild -Tag "${imageName}" -Context "."
        if ($exitCode -eq 0) {
            Write-Host "Build completed successfully!" -ForegroundColor Green
        } else {
            Write-Error "Build failed (exit code $exitCode). Exiting."
            exit $exitCode
        }
    }
    "run" {
        # Build if requested or image doesn't exist
        $imageExists = docker images -q "${imageName}"
        if ($Rebuild -or -not $imageExists) {
            $exitCode = Run-DockerBuild -Tag "${imageName}" -Context "."
            if ($exitCode -ne 0) {
                Write-Error "Build failed (exit code $exitCode). Exiting."
                exit $exitCode
            }
        }

        # Stop and remove existing container
        $containerExists = docker ps -aq --filter "name=$containerName"
        if ($containerExists) {
            Write-Host "Stopping and removing existing container..." -ForegroundColor Yellow
            docker stop $containerName | Out-Null
            docker rm $containerName | Out-Null
        }

        # Run container
        Write-Host "Starting container..." -ForegroundColor Yellow
        if ($Mode -eq "prod") {
            $envFile = "dist/prod/.env"
            $envArg = ""
            if (Test-Path $envFile) {
                # Use "=" form so docker receives a single valid flag token: --env-file=<file>
                $envArg = "--env-file=$envFile"
            } else {
                Write-Warning "Production env file '$envFile' not found. Proceeding without --env-file."
            }
            docker run -d --name $containerName -p ${hostPort}:${containerPort} $envArg "${imageName}"
        } else {
            $envFile = ".env"
            $envArg = ""
            if (Test-Path $envFile) {
                # Use "=" form for consistency and to avoid PowerShell tokenization issues
                $envArg = "--env-file=$envFile"
            } else {
                Write-Warning "Dev env file '$envFile' not found. Proceeding without --env-file."
            }
            # Ensure host node_modules exists so the container can bind it without masking image modules
            $nodeModulesHost = Join-Path $PWD "node_modules"
            if (-not (Test-Path $nodeModulesHost)) {
                New-Item -ItemType Directory -Path $nodeModulesHost | Out-Null
            }
            docker run -d --name $containerName -p ${hostPort}:${containerPort} $envArg -v "${PWD}:/app" -v "${nodeModulesHost}:/app/node_modules" "${imageName}"
        }

        if ($LASTEXITCODE -eq 0) {
            Write-Host "Container started successfully!" -ForegroundColor Green
            Write-Host "Access your app at: http://localhost:$hostPort" -ForegroundColor Cyan
            Write-Host "Health check: http://localhost:$hostPort/health" -ForegroundColor Cyan
        }
    }
    "stop" {
        Write-Host "Stopping container..." -ForegroundColor Yellow
        docker stop $containerName
        docker rm $containerName
    }
    "logs" {
        docker logs -f $containerName
    }
    "compose-up" {
        Write-Host "Starting with Docker Compose..." -ForegroundColor Yellow
        docker-compose --profile $Mode up -d
    }
    "compose-down" {
        Write-Host "Stopping with Docker Compose..." -ForegroundColor Yellow
        docker-compose --profile $Mode down
    }
    default {
        Write-Host "Available actions: build, run, stop, logs, compose-up, compose-down" -ForegroundColor Yellow
    }
}