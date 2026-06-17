# PowerShell Deployment Helper Script for Azure Cloud Shell
# Run this script inside Azure Cloud Shell (https://shell.azure.com)

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " ArcReach Azure Deployment Assistant 🚀" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. Configuration & Parameters
$location = Read-Host "Enter Azure Region [eastus]"
if ([string]::IsNullOrWhiteSpace($location)) { $location = "eastus" }

$resourceGroup = Read-Host "Enter Resource Group Name [Self_Hosted-Apps]"
if ([string]::IsNullOrWhiteSpace($resourceGroup)) { $resourceGroup = "Self_Hosted-Apps" }

$dbAdminPassword = Read-Host "Enter PostgreSQL Admin Password [Secure password, min 8 chars]"
if ([string]::IsNullOrWhiteSpace($dbAdminPassword)) {
    # Generate a random password if empty
    $dbAdminPassword = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 16 | ForEach-Object {[char]$_})
    Write-Host "Generated DB Admin Password: $dbAdminPassword" -ForegroundColor Yellow
}

$adminEmail = Read-Host "Enter Admin Email for ArcReach [admin@arcreach.com]"
if ([string]::IsNullOrWhiteSpace($adminEmail)) { $adminEmail = "admin@arcreach.com" }

$adminPassword = Read-Host "Enter Admin Login Password [Secure password, min 8 chars]"
if ([string]::IsNullOrWhiteSpace($adminPassword)) {
    # Generate a random password if empty
    $adminPassword = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 16 | ForEach-Object {[char]$_})
    Write-Host "Generated Admin Password: $adminPassword" -ForegroundColor Yellow
}

Write-Host "`nCreating Resource Group '$resourceGroup' in region '$location'..." -ForegroundColor Green
az group create --name $resourceGroup --location $location

# Move to the infra directory if we aren't already there
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($scriptPath -and (Test-Path $scriptPath)) {
    Set-Location $scriptPath
}

# -------------------------------------------------------------------------
# Phase 1: Infrastructure Bootstrap (ACR, PostgreSQL, Log Analytics)
# -------------------------------------------------------------------------
Write-Host "`n[Phase 1] Bootstrapping Azure Infrastructure (ACR, Database, Logging)..." -ForegroundColor Green
$bootstrapDeployment = az deployment group create `
  --resource-group $resourceGroup `
  --template-file main.bicep `
  --parameters deployContainerApp=false `
               dbAdminPassword=$dbAdminPassword `
               adminPassword=$adminPassword `
               adminEmail=$adminEmail | ConvertFrom-Json

$acrName = $bootstrapDeployment.properties.outputs.acrName.value
$acrLoginServer = $bootstrapDeployment.properties.outputs.acrLoginServer.value
$pgFqdn = $bootstrapDeployment.properties.outputs.pgFqdn.value

Write-Host "Bootstrap completed." -ForegroundColor Cyan
Write-Host "Registry Name: $acrName"
Write-Host "Registry URL:  $acrLoginServer"
Write-Host "PostgreSQL:    $pgFqdn"

# -------------------------------------------------------------------------
# Phase 2: Build Container Image in the Cloud (ACR Build Task)
# -------------------------------------------------------------------------
Write-Host "`n[Phase 2] Building Docker image in the cloud via ACR Tasks..." -ForegroundColor Green
# Move to the root directory where the Dockerfile and source files are
Set-Location ..
az acr build --registry $acrName --image arcreach:latest .

# -------------------------------------------------------------------------
# Phase 3: Run Database Migrations & Seeding
# -------------------------------------------------------------------------
Write-Host "`n[Phase 3] Syncing PostgreSQL database schema (Prisma)..." -ForegroundColor Green
$env:DATABASE_URL = "postgresql://arcadmin:${dbAdminPassword}@${pgFqdn}:5432/arcreach?sslmode=require"
$env:ADMIN_EMAIL = $adminEmail
$env:ADMIN_PASSWORD = $adminPassword
$env:ADMIN_NAME = "ArcReach Admin"

# Install project dependencies locally in Cloud Shell to run Prisma commands
Write-Host "Installing dependencies in Cloud Shell (this may take a minute)..." -ForegroundColor Cyan
npm install --no-audit --no-fund

Write-Host "Deploying Prisma schema to database..." -ForegroundColor Cyan
npx prisma db push --accept-data-loss

Write-Host "Seeding the administrator account..." -ForegroundColor Cyan
npx tsx scripts/seed-admin.ts

# -------------------------------------------------------------------------
# Phase 4: Deploy the Container App
# -------------------------------------------------------------------------
Write-Host "`n[Phase 4] Deploying Azure Container App..." -ForegroundColor Green
Set-Location infra
$finalDeployment = az deployment group create `
  --resource-group $resourceGroup `
  --template-file main.bicep `
  --parameters deployContainerApp=true `
               dbAdminPassword=$dbAdminPassword `
               adminPassword=$adminPassword `
               adminEmail=$adminEmail | ConvertFrom-Json

$appUrl = $finalDeployment.properties.outputs.appUrl.value

Write-Host "`n==================================================" -ForegroundColor Green
Write-Host " 🎉 ArcReach Deployed Successfully! " -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host "Application URL: https://$appUrl" -ForegroundColor Cyan
Write-Host "Admin Email:     $adminEmail"
Write-Host "Database FQDN:   $pgFqdn"
Write-Host "Remember to save your DB Admin Password: $dbAdminPassword" -ForegroundColor Yellow
Write-Host "==================================================" -ForegroundColor Green
