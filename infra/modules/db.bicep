param location string
param pgServerName string
param dbName string
param dbAdminLogin string

@secure()
param dbAdminPassword string

resource pgServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01' = {
  name: pgServerName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '15'
    administratorLogin: dbAdminLogin
    administratorLoginPassword: dbAdminPassword
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01' = {
  parent: pgServer
  name: dbName
}

// Allow connections from Azure internal services (e.g. Container Apps)
resource pgFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01' = {
  parent: pgServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

output fqdn string = pgServer.properties.fullyQualifiedDomainName
output dbName string = pgDb.name
