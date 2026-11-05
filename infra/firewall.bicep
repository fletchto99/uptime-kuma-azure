param serverName string
@minLength(1)
param addresses array

resource server 'Microsoft.DBforMySQL/flexibleServers@2025-12-01-preview' existing = {
  name: serverName
}

resource rules 'Microsoft.DBforMySQL/flexibleServers/firewallRules@2024-12-30' = [for (ip, index) in addresses: {
  parent: server
  name: 'app-egress-${index}'
  properties: {
    startIpAddress: ip
    endIpAddress: ip
  }
}]
