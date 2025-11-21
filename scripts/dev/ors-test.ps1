param(
  # Bruk porten Netlify viser. Standard her er 8889 siden det er det du fikk sist.
  [string]$BaseUrl = "http://localhost:8889",

  # Origin: Oslo sentrum (kan overstyres)
  [double]$OriginLat = 59.91273,
  [double]$OriginLng = 10.74609,

  # Ekstra destinasjoner (format: "Navn:lat,lng"), valgfritt.
  # Eksempel: -ExtraDest "Hamar:60.7945,11.0670","Gjøvik:60.7957,10.6916"
  [string[]]$ExtraDest = @()
)

# Standarddestinasjoner: Stange + Lillehammer
$destList = @(
  @{ name = "Stange";       lat = 60.71865; lng = 11.19100 }
  @{ name = "Lillehammer";  lat = 61.11527; lng = 10.46628 }
)

# Parse eventuelle ekstra destinasjoner gitt som "Navn:lat,lng"
foreach ($d in $ExtraDest) {
  if ($d -match "^(?<name>[^:]+):(?<lat>-?\d+(\.\d+)?),(?<lng>-?\d+(\.\d+)?)$") {
    $destList += @{
      name = $Matches["name"].Trim()
      lat  = [double]$Matches["lat"]
      lng  = [double]$Matches["lng"]
    }
  } else {
    Write-Warning "Ignorerer ekstra destinasjon (formatfeil): $d  — bruk 'Navn:lat,lng'"
  }
}

if ($destList.Count -eq 0) {
  Write-Error "Ingen destinasjoner å teste. Legg til minst én."
  exit 1
}

# Bygg body til funksjonen
$bodyObj = @{
  origin = @{ lat = $OriginLat; lng = $OriginLng }
  destinations = @()
  profile = "driving-car"
}

# Hold navneliste i parallell for pen utskrift
$names = @()
foreach ($d in $destList) {
  $bodyObj.destinations += @{ lat = $d.lat; lng = $d.lng }
  $names += $d.name
}

$bodyJson = $bodyObj | ConvertTo-Json -Depth 5

# Kall funksjonen
$uri = "$BaseUrl/.netlify/functions/ors-matrix"
Write-Host "POST $uri"
try {
  $resp = Invoke-RestMethod -Method POST -Uri $uri -ContentType "application/json" -Body $bodyJson -ErrorAction Stop
} catch {
  Write-Error "Kallet feilet. Sjekk at 'netlify dev' kjører og at BaseUrl er riktig. Detalj: $($_.Exception.Message)"
  exit 1
}

# Forventet respons: { ok, distances_m[], durations_s[] }
if (-not $resp.ok) {
  Write-Warning "Respons ok=false. Detaljer:"
  $resp | ConvertTo-Json -Depth 6
  exit 2
}

# Presenter resultat pent
$dist = @($resp.distances_m)
$dur  = @($resp.durations_s)

Write-Host ""
Write-Host "=== ORS Matrix resultat (origin: $OriginLat,$OriginLng) ==="
for ($i = 0; $i -lt $names.Count; $i++) {
  $km  = if ($dist[$i] -ne $null) { [math]::Round($dist[$i] / 1000, 2) } else { $null }
  $min = if ($dur[$i]  -ne $null) { [math]::Round($dur[$i] / 60,   1) }  else { $null }

  $kmTxt  = if ($km  -ne $null) { "$km km" } else { "–" }
  $minTxt = if ($min -ne $null) { "$min min" } else { "–" }

  Write-Host ("{0,2}. {1,-20}  Avstand: {2,8}   Tid: {3,8}" -f ($i+1), $names[$i], $kmTxt, $minTxt)
}

# Returner også rå JSON hvis du vil pipe videre
# $resp | ConvertTo-Json -Depth 6
