param location string
param caEnvName string
param containerAppName string
param acrName string
param logAnalyticsId string
param dbFqdn string
param dbName string
param dbAdminLogin string

@secure()
param dbAdminPassword string

param adminEmail string
param adminName string

@secure()
param adminPassword string

// Reference the existing Container Registry to retrieve credentials securely
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

// Managed Environment for Container Apps
resource caEnv 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: caEnvName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: reference(logAnalyticsId, '2022-10-01').customerId
        sharedKey: listKeys(logAnalyticsId, '2022-10-01').primarySharedKey
      }
    }
  }
}

var dbConnectionString = 'postgresql://${dbAdminLogin}:${dbAdminPassword}@${dbFqdn}:5432/${dbName}?sslmode=require'

// Container App
resource containerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: containerAppName
  location: location
  properties: {
    managedEnvironmentId: caEnv.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
      }
      registries: [
        {
          server: '${acrName}.azurecr.io'
          username: acrName
          passwordSecretRef: 'registry-password'
        }
      ]
      secrets: [
        {
          name: 'registry-password'
          value: acr.listCredentials().passwords[0].value
        }
        {
          name: 'db-connection-string'
          value: dbConnectionString
        }
        {
          name: 'admin-password'
          value: adminPassword
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'arcreach-web'
          image: '${acrName}.azurecr.io/arcreach:latest'
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'db-connection-string'
            }
            {
              name: 'APP_URL'
              value: 'https://${containerAppName}.${caEnv.properties.defaultDomain}'
            }
            {
              name: 'ADMIN_EMAIL'
              value: adminEmail
            }
            {
              name: 'ADMIN_PASSWORD'
              secretRef: 'admin-password'
            }
            {
              name: 'ADMIN_NAME'
              value: adminName
            }
            {
              name: 'NODE_ENV'
              value: 'production'
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
}

output fqdn string = containerApp.properties.configuration.ingress.fqdn
