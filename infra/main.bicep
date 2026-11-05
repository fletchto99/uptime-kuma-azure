targetScope = 'resourceGroup'

param location string = 'centralus'
@minLength(3)
@maxLength(40)
param name string
@description('Approved immutable public image, ghcr.io/...@sha256:...; never latest.')
param image string
@description('Operator public IPv4 for initial setup only. Never 0.0.0.0.')
param operatorIPv4 string
param databaseAdministrator string
@secure()
param databaseAdministratorPassword string
@secure()
param databasePassword string

resource plan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: '${name}-plan'
  location: location
  kind: 'linux'
  sku: {
    name: 'B1'
    tier: 'Basic'
    capacity: 1
  }
  // Avoid allocating a paid web worker when database provisioning fails.
  dependsOn: [
    database
  ]
  properties: {
    reserved: true
  }
}

// 8.4 is GA, but the stable 2024-12-30 ARM schema still only lists 5.7/8.0.
resource mysql 'Microsoft.DBforMySQL/flexibleServers@2025-12-01-preview' = {
  name: '${name}-mysql'
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '8.4'
    administratorLogin: databaseAdministrator
    administratorLoginPassword: databaseAdministratorPassword
    createMode: 'Default'
    storage: {
      storageSizeGB: 20
      autoGrow: 'Disabled'
      autoIoScaling: 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

resource database 'Microsoft.DBforMySQL/flexibleServers/databases@2024-12-30' = {
  parent: mysql
  name: 'kuma'
  properties: {
    charset: 'utf8mb4'
    collation: 'utf8mb4_unicode_ci'
  }
}

resource requireTls 'Microsoft.DBforMySQL/flexibleServers/configurations@2024-12-30' = {
  parent: mysql
  name: 'require_secure_transport'
  properties: {
    value: 'ON'
    source: 'user-override'
  }
}

resource tlsVersion 'Microsoft.DBforMySQL/flexibleServers/configurations@2024-12-30' = {
  parent: mysql
  name: 'tls_version'
  properties: {
    value: 'TLSv1.2,TLSv1.3'
    source: 'user-override'
  }
}

resource app 'Microsoft.Web/sites@2024-11-01' = {
  name: name
  location: location
  kind: 'app,linux,container'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'sitecontainers'
      alwaysOn: true
      numberOfWorkers: 1
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      ftpsState: 'Disabled'
      ipSecurityRestrictionsDefaultAction: 'Deny'
      ipSecurityRestrictions: [
        {
          name: 'initial-operator-only'
          action: 'Allow'
          priority: 100
          ipAddress: '${operatorIPv4}/32'
        }
      ]
      scmIpSecurityRestrictionsUseMain: true
      appSettings: [
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'true' }
        { name: 'DATA_DIR', value: '/home/kuma/' }
        { name: 'UPTIME_KUMA_DB_TYPE', value: 'mariadb' }
        { name: 'UPTIME_KUMA_DB_HOSTNAME', value: mysql.properties.fullyQualifiedDomainName }
        { name: 'UPTIME_KUMA_DB_PORT', value: '3306' }
        { name: 'UPTIME_KUMA_DB_NAME', value: database.name }
        { name: 'UPTIME_KUMA_DB_USERNAME', value: 'kuma' }
        { name: 'UPTIME_KUMA_DB_PASSWORD', value: databasePassword }
        { name: 'UPTIME_KUMA_DB_SSL', value: 'true' }
        { name: 'UPTIME_KUMA_DB_POOL_MAX_CONNECTIONS', value: '5' }
        { name: 'DOCKER_ENABLE_CI', value: 'false' }
      ]
    }
  }
}

resource mainContainer 'Microsoft.Web/sites/sitecontainers@2024-11-01' = {
  parent: app
  name: 'main'
  properties: {
    image: image
    isMain: true
    targetPort: '3001'
    authType: 'Anonymous'
    inheritAppSettingsAndConnectionStrings: true
    startUpCommand: 'sh -c "umask 077; exec node server/server.js"'
  }
}

resource ftpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: app
  name: 'ftp'
  properties: {
    allow: false
  }
}

resource scmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: app
  name: 'scm'
  properties: {
    allow: false
  }
}

module appFirewall 'firewall.bicep' = {
  name: '${name}-firewall'
  params: {
    serverName: mysql.name
    addresses: split(app.properties.possibleOutboundIpAddresses, ',')
  }
}

resource operatorFirewall 'Microsoft.DBforMySQL/flexibleServers/firewallRules@2024-12-30' = {
  parent: mysql
  name: 'temporary-operator'
  properties: {
    startIpAddress: operatorIPv4
    endIpAddress: operatorIPv4
  }
}

// These outputs are for a private operator terminal, never public CI logs.
output appHostname string = app.properties.defaultHostName
output domainVerificationId string = app.properties.customDomainVerificationId
output databaseHostname string = mysql.properties.fullyQualifiedDomainName
