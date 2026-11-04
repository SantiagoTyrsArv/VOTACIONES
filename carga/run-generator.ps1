param(
  [Parameter(Mandatory=$true)][ValidateRange(0,3)][int]$Index,
  [Parameter(Mandatory=$true)][string]$WsUrl,
  [int]$Connections=20000,
  [int]$RampSeconds=120,
  [int]$HoldSeconds=180
)
$segments=@('0','1/4','1/2','3/4','1')
$startSegment=$segments[$Index]
$endSegment=$segments[$Index+1]
k6 run --execution-segment "$startSegment`:$endSegment" --execution-segment-sequence '0,1/4,1/2,3/4,1' -e "WS_URL=$WsUrl" -e "CONNECTIONS=$Connections" -e "RAMP_SECONDS=$RampSeconds" -e "HOLD_SECONDS=$HoldSeconds" --summary-export "generator-$Index.json" "$PSScriptRoot/connections.js"
exit $LASTEXITCODE
