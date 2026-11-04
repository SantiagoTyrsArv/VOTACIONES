<#
.SYNOPSIS
  Crea o actualiza el preconteo en Azure Container Apps (main.bicep).

.DESCRIPTION
  Requisitos: Azure CLI (az) con sesión iniciada (az login) en la suscripción
  "Azure for Students". La primera vez genera los secretos en
  deploy/azure/.secretos.local.json (no se versiona): guárdelo, porque las
  credenciales de jurados y auditores dependen de él.

.EXAMPLE
  ./deploy/azure/desplegar.ps1                       # 1 réplica (día a día)
  ./deploy/azure/desplegar.ps1 -Replicas 8           # carga y sustentación
  ./deploy/azure/desplegar.ps1 -Imagen ghcr.io/santiagotyrsarv/votaciones:<sha>
#>
param(
  [string]$Grupo = 'rg-votaciones',
  # Vacío = se elige una región permitida por la política de la suscripción (Azure for Students
  # limita las regiones) en la que exista Container Apps.
  [string]$Ubicacion = '',
  [ValidateRange(1, 10)][int]$Replicas = 1,
  [string]$Imagen = 'ghcr.io/santiagotyrsarv/votaciones:latest',
  [switch]$Demo,
  [switch]$CargarCatalogo
)
$ErrorActionPreference = 'Stop'
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$archivoSecretos = Join-Path $aqui '.secretos.local.json'

function Invoke-Az {
  & az @args
  if ($LASTEXITCODE -ne 0) { throw "Falló: az $($args -join ' ')" }
}

function New-Secreto([int]$largo = 48) {
  # Se generan bytes de sobra: base64 sin +/= sigue siendo más largo que $largo.
  $bytes = New-Object byte[] ($largo * 2)
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return ([Convert]::ToBase64String($bytes) -replace '[+/=]', '').Substring(0, $largo)
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Instale Azure CLI: winget install -e --id Microsoft.AzureCLI (y abra otra terminal).'
}
& az account show --only-show-errors *> $null
if ($LASTEXITCODE -ne 0) { throw 'Inicie sesión primero: az login' }

function Get-RegionPermitida {
  # Regiones de la política "Allowed locations" asignada a la suscripción.
  $permitidas = @(& az policy assignment list --query '[].parameters.listOfAllowedLocations.value[]' -o tsv --only-show-errors 2>$null |
      Where-Object { $_ } | ForEach-Object { $_.Trim().ToLower() })
  $conApps = @(& az provider show --namespace Microsoft.App `
      --query "resourceTypes[?resourceType=='managedEnvironments'].locations[]" -o tsv --only-show-errors |
      ForEach-Object { ($_ -replace ' ', '').ToLower() })
  $preferidas = 'eastus', 'westus2', 'westus3', 'centralus', 'southcentralus', 'northcentralus', 'brazilsouth',
    'canadacentral', 'westeurope', 'northeurope', 'uksouth', 'francecentral', 'swedencentral'
  $candidatas = if ($permitidas.Count) { $permitidas | Where-Object { $conApps -contains $_ } } else { $preferidas }
  if ($permitidas.Count) {
    Write-Host "  Regiones permitidas por la suscripción: $($permitidas -join ', ')"
  }
  $elegida = ($preferidas | Where-Object { $candidatas -contains $_ } | Select-Object -First 1)
  if (-not $elegida) { $elegida = $candidatas | Select-Object -First 1 }
  if (-not $elegida) { throw 'No hay una región permitida con Container Apps. Indique una con -Ubicacion.' }
  return $elegida
}

Write-Host '· Extensión containerapp y proveedores…'
Invoke-Az extension add --name containerapp --upgrade --only-show-errors
foreach ($p in 'Microsoft.App', 'Microsoft.OperationalInsights', 'Microsoft.Storage') {
  Invoke-Az provider register --namespace $p --only-show-errors
}

if (-not (Test-Path $archivoSecretos)) {
  Write-Host "· Generando secretos en $archivoSecretos (guárdelo en un lugar seguro)…"
  $secretos = [ordered]@{
    redisPassword = New-Secreto 40
    juradoSecreto = New-Secreto 48
    metricsToken  = New-Secreto 40
    auditores     = [ordered]@{
      (New-Secreto 32) = @{ id = 'ana'; name = 'Ana Torres'; role = 'auditor' }
      (New-Secreto 32) = @{ id = 'luis'; name = 'Luis Rojas'; role = 'auditor' }
      (New-Secreto 32) = @{ id = 'coordinacion'; name = 'Coordinación'; role = 'coordinator' }
    }
  }
  $secretos | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $archivoSecretos
}
$s = Get-Content -Raw $archivoSecretos | ConvertFrom-Json

# Los parámetros seguros van en un archivo temporal: no quedan en el historial de la terminal.
$parametros = @{
  '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
  contentVersion = '1.0.0.0'
  parameters     = @{
    imagen                 = @{ value = $Imagen }
    replicas               = @{ value = $Replicas }
    demo                   = @{ value = [bool]$Demo }
    redisPassword          = @{ value = $s.redisPassword }
    juradoSecreto          = @{ value = $s.juradoSecreto }
    metricsToken           = @{ value = $s.metricsToken }
    auditorCredentialsJson = @{ value = ($s.auditores | ConvertTo-Json -Compress -Depth 4) }
  }
}
$temporal = Join-Path ([IO.Path]::GetTempPath()) "votaciones-params-$([guid]::NewGuid()).json"
$parametros | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $temporal
try {
  if (-not $Ubicacion) { $Ubicacion = Get-RegionPermitida }
  $parametros.parameters.location = @{ value = $Ubicacion }
  $parametros | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $temporal
  # El grupo solo guarda metadatos: si ya existe (aunque sea en otra región) se reutiliza.
  & az group show --name $Grupo --only-show-errors *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "· Grupo de recursos $Grupo en ${Ubicacion}…"
    Invoke-Az group create --name $Grupo --location $Ubicacion --only-show-errors --output none
  } else {
    Write-Host "· Grupo de recursos $Grupo (existente); recursos en ${Ubicacion}…"
  }
  Write-Host "· Desplegando ($Replicas réplica(s), imagen ${Imagen})…"
  $salida = & az deployment group create --resource-group $Grupo --name votaciones `
    --template-file (Join-Path $aqui 'main.bicep') --parameters "@$temporal" `
    --query properties.outputs --output json --only-show-errors
  if ($LASTEXITCODE -ne 0) { throw 'Falló el despliegue (revise el mensaje de az).' }
} finally {
  Remove-Item $temporal -ErrorAction SilentlyContinue
}
$url = ($salida | ConvertFrom-Json).url.value

if ($CargarCatalogo) {
  Write-Host '· Cargando el catálogo (Job votaciones-catalogo)…'
  Invoke-Az containerapp job start --name votaciones-catalogo --resource-group $Grupo --only-show-errors --output none
}

Write-Host ''
Write-Host "Listo: $url" -ForegroundColor Green
Write-Host "  Público:     $url/publico/"
Write-Host "  Jurados:     $url/jurado/   (credenciales: npm run credenciales, con el juradoSecreto del archivo de secretos)"
Write-Host "  Consola:     $url/          (credenciales de auditores en $archivoSecretos)"
Write-Host "  Réplica:     $url/whoami"
if (-not $CargarCatalogo) { Write-Host '  Primera vez: vuelva a ejecutar con -CargarCatalogo para cargar las 6.400 mesas.' }
