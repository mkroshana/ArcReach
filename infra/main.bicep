param location string = resourceGroup().location
param appName string = 'arcreach'
param environment string = 'dev'

param dbName string = 'arcreach'
param dbAdminLogin string = 'arcadmin'

@secure()
param dbAdminPassword string

param adminEmail string = 'admin@arcreach.com'
param adminName string = 'ArcReach Admin'

@secure()
param adminPassword string

param deployContainerApp bool = true

var uniqueSuffix = uniqueString(resourceGroup().id)
var acrName = take(toLower('${appName}registry${uniqueSuffix}'), 40)
var pgServerName = toLower('${appName}-db-${uniqueSuffix}')
var logAnalyticsName = '${appName}-logs-${uniqueSuffix}'
var caEnvName = '${appName}-env-${uniqueSuffix}'
var containerAppName = '${appName}-app-${uniqueSuffix}'

// 1. Deploy Container Registry
module acr './modules/acr.bicep' = {
  name: 'acr-deployment'
  params: {
    location: location
    acrName: acrName
  }
}

// 2. Deploy Log Analytics Workspace
module loganalytics './modules/loganalytics.bicep' = {
  name: 'loganalytics-deployment'
  params: {
    location: location
    logAnalyticsName: logAnalyticsName
  }
}

// 3. Deploy PostgreSQL Database Server
module db './modules/db.bicep' = {
  name: 'db-deployment'
  params: {
    location: location
    pgServerName: pgServerName
    dbName: dbName
    dbAdminLogin: dbAdminLogin
    dbAdminPassword: dbAdminPassword
  }
}

// 4. Deploy Container App (Conditional)
module aca './modules/aca.bicep' = if (deployContainerApp) {
  name: 'aca-deployment'
  params: {
    location: location
    caEnvName: caEnvName
    containerAppName: containerAppName
    acrName: acr.outputs.acrName
    logAnalyticsId: loganalytics.outputs.id
    dbFqdn: db.outputs.fqdn
    dbName: db.outputs.dbName
    dbAdminLogin: dbAdminLogin
    dbAdminPassword: dbAdminPassword
    adminEmail: adminEmail
    adminName: adminName
    adminPassword: adminPassword
  }
}

output acrLoginServer string = acr.outputs.acrLoginServer
output acrName string = acr.outputs.acrName
output appUrl string = deployContainerApp ? aca.outputs.fqdn : ''
output pgFqdn string = db.outputs.fqdn
