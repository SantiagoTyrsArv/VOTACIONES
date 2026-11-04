// Preconteo electoral en Azure Container Apps (plan de consumo).
//
//   - votaciones        N réplicas idénticas detrás del balanceador de Container Apps,
//                       sin afinidad de sesión (RT-1, RT-2). Solo comparten Redis (RT-3).
//   - votaciones-redis  Redis 7 con AOF everysec sobre Azure Files, alcanzable solo por
//                       TCP interno dentro del entorno.
//   - votaciones-catalogo  Job manual que carga el catálogo de mesas (una vez).
//
// Idempotente: volver a ejecutarla actualiza los recursos. Ver docs/despliegue-azure.md.

@description('Región. Debe admitir Container Apps.')
param location string = resourceGroup().location

@description('Prefijo de los recursos.')
param nombre string = 'votaciones'

@description('Imagen de la aplicación (la publica .github/workflows/imagen.yml).')
param imagen string

@description('Réplicas fijas de la aplicación: 1 en el día a día, 8 para carga y sustentación.')
@minValue(1)
@maxValue(10)
param replicas int = 1

@description('vCPU por réplica (0.25, 0.5, 0.75, 1…).')
param cpu string = '0.5'

@description('Memoria por réplica; debe ir con la vCPU (0.5 → 1Gi).')
param memoria string = '1Gi'

@description('Modo demostración de C (credenciales demo-*). En la sustentación: false.')
param demo bool = false

@secure()
@description('Contraseña de Redis.')
param redisPassword string

@secure()
@description('Secreto HMAC de las credenciales de jurados (mínimo 32 caracteres).')
param juradoSecreto string

@secure()
@description('Token Bearer para leer /metrics (Prometheus).')
param metricsToken string

@secure()
@description('JSON {"<credencial de 24+ caracteres>": {"id","name","role"}} de auditores y coordinación.')
param auditorCredentialsJson string

@description('Orígenes permitidos para la consola (coma). Vacío = mismo host.')
param allowedOrigins string = ''

@description('Usuario de GHCR si la imagen es privada (vacío si es pública).')
param registroUsuario string = ''

@secure()
@description('Token de GHCR (read:packages) si la imagen es privada.')
param registroToken string = ''

var usaRegistroPrivado = !empty(registroUsuario)
var redisApp = '${nombre}-redis'
var redisUrl = 'redis://:${redisPassword}@${redisApp}:6379'
var cuentaAlmacen = take('${replace(nombre, '-', '')}${uniqueString(resourceGroup().id)}', 24)

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${nombre}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource almacen 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: cuentaAlmacen
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  identity: { type: 'SystemAssigned' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    // Cifrado en reposo con claves de Microsoft (explícito).
    encryption: {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true
      services: {
        file: { enabled: true, keyType: 'Account' }
        blob: { enabled: true, keyType: 'Account' }
      }
    }
  }
}

resource archivos 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: almacen
  name: 'default'
}

resource recursoRedis 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: archivos
  name: 'redis-datos'
  properties: { shareQuota: 1 }
}

resource entorno 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${nombre}-entorno'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource volumenRedis 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: entorno
  name: 'redisdatos'
  properties: {
    azureFile: {
      accountName: almacen.name
      accountKey: almacen.listKeys().keys[0].value
      shareName: recursoRedis.name
      accessMode: 'ReadWrite'
    }
  }
}

resource redis 'Microsoft.App/containerApps@2024-03-01' = {
  name: redisApp
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: entorno.id
    configuration: {
      ingress: {
        external: false
        transport: 'tcp'
        targetPort: 6379
        exposedPort: 6379
        // Excepción a S6382: ingress TCP interno (no expuesto a Internet). Redis habla TCP plano
        // y autentica con requirepass; exigir certificados de cliente cortaría a las réplicas.
        clientCertificateMode: 'accept' // NOSONAR
      }
      secrets: [{ name: 'redis-password', value: redisPassword }]
    }
    template: {
      containers: [
        {
          name: 'redis'
          image: 'redis:7.4-alpine'
          // Se invoca redis-server directamente (como root): el entrypoint de la imagen
          // intenta cambiar el dueño de /data, que en Azure Files (SMB) no se puede.
          command: ['/bin/sh', '-c']
          args: [
            'exec redis-server --dir /data --appendonly yes --appendfsync everysec --maxmemory-policy noeviction --requirepass "$REDIS_PASSWORD"'
          ]
          env: [{ name: 'REDIS_PASSWORD', secretRef: 'redis-password' }]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          volumeMounts: [{ volumeName: 'datos', mountPath: '/data' }]
        }
      ]
      volumes: [{ name: 'datos', storageType: 'AzureFile', storageName: volumenRedis.name }]
      // Una sola instancia: los scripts Lua tocan muchas claves (sin clúster).
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

var secretosApp = concat(
  [
    { name: 'redis-url', value: redisUrl }
    { name: 'jurado-secreto', value: juradoSecreto }
    { name: 'metrics-token', value: metricsToken }
    { name: 'auditores', value: auditorCredentialsJson }
  ],
  usaRegistroPrivado ? [{ name: 'registro-token', value: registroToken }] : []
)

var entornoApp = [
  { name: 'REDIS_URL', secretRef: 'redis-url' }
  { name: 'JURADO_SECRETO', secretRef: 'jurado-secreto' }
  { name: 'METRICS_TOKEN', secretRef: 'metrics-token' }
  { name: 'AUDITOR_CREDENTIALS_JSON', secretRef: 'auditores' }
  { name: 'DEMO_MODE', value: string(demo) }
  { name: 'EXPECTED_REPLICAS', value: string(replicas) }
  { name: 'ALLOWED_ORIGINS', value: allowedOrigins }
  { name: 'HOST', value: '0.0.0.0' }
  { name: 'PORT', value: '3000' }
  { name: 'LOG_LEVEL', value: 'warn' }
  { name: 'NODE_ENV', value: 'production' }
]

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: nombre
  location: location
  identity: { type: 'SystemAssigned' }
  dependsOn: [redis]
  properties: {
    managedEnvironmentId: entorno.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        // auto = HTTP/1.1 con upgrade a WebSocket; SSE es HTTP normal.
        transport: 'auto'
        allowInsecure: false
        // Sin sesiones pegajosas: cualquier réplica atiende a cualquier cliente (RT-2).
        stickySessions: { affinity: 'none' }
      }
      secrets: secretosApp
      registries: usaRegistroPrivado
        ? [{ server: 'ghcr.io', username: registroUsuario, passwordSecretRef: 'registro-token' }]
        : []
    }
    template: {
      containers: [
        {
          name: 'votaciones'
          image: imagen
          env: entornoApp
          resources: { cpu: json(cpu), memory: memoria }
          probes: [
            // /live siempre 200: si Redis cae, la plataforma no reinicia las réplicas en bucle.
            { type: 'Liveness', httpGet: { path: '/live', port: 3000 }, periodSeconds: 10 }
            // /ready 503 sin Redis: el balanceador deja de enviarle tráfico (RF-10).
            { type: 'Readiness', httpGet: { path: '/ready', port: 3000 }, periodSeconds: 5, failureThreshold: 3 }
            { type: 'Startup', httpGet: { path: '/live', port: 3000 }, periodSeconds: 3, failureThreshold: 20 }
          ]
        }
      ]
      // Réplicas fijas: el enunciado exige N instancias, no autoescalado.
      scale: { minReplicas: replicas, maxReplicas: replicas }
    }
  }
}

// Carga del catálogo (6.400 mesas, asignación jurado → mesa). Se lanza a mano una vez.
resource catalogo 'Microsoft.App/jobs@2024-03-01' = {
  name: '${nombre}-catalogo'
  location: location
  identity: { type: 'SystemAssigned' }
  dependsOn: [redis]
  properties: {
    environmentId: entorno.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 1
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      secrets: secretosApp
      registries: usaRegistroPrivado
        ? [{ server: 'ghcr.io', username: registroUsuario, passwordSecretRef: 'registro-token' }]
        : []
    }
    template: {
      containers: [
        {
          name: 'catalogo'
          image: imagen
          command: ['node', 'herramientas/dist/catalogo.js']
          env: [{ name: 'REDIS_URL', secretRef: 'redis-url' }]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
    }
  }
}

output url string = 'https://${app.properties.configuration.ingress.fqdn}'
output replicas int = replicas
