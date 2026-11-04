<#
.SYNOPSIS
  Cambia el número fijo de réplicas sin redesplegar (ahorra crédito).

.EXAMPLE
  ./deploy/azure/escalar.ps1 -Replicas 8   # antes de la prueba de carga o la sustentación
  ./deploy/azure/escalar.ps1 -Replicas 1   # al terminar
#>
param(
  [Parameter(Mandatory)][ValidateRange(1, 10)][int]$Replicas,
  [string]$Grupo = 'rg-votaciones',
  [string]$Nombre = 'votaciones'
)
$ErrorActionPreference = 'Stop'
& az containerapp update --name $Nombre --resource-group $Grupo `
  --min-replicas $Replicas --max-replicas $Replicas `
  --set-env-vars "EXPECTED_REPLICAS=$Replicas" --only-show-errors --output none
if ($LASTEXITCODE -ne 0) { throw 'No se pudo escalar (¿az login? ¿existe el despliegue?).' }
Write-Host "Réplicas fijadas en $Replicas. Compruebe con: az containerapp replica list -n $Nombre -g $Grupo -o table"
