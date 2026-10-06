# Publica el APK en el servidor (descarga protegida con links personales) y retira la copia publica.
#
#   .\publicar-apk.ps1                      (publica el APK 1.5 y pregunta si retirar la copia publica)
#   .\publicar-apk.ps1 -NoRetirarPublico    (solo publica; no toca la copia publica)
#
# Que hace, en orden (y se detiene si algo falla):
#   1. Revisa el APK en tu PC: version (contra build.gradle) y que este firmado con tu clave de release.
#   2. Lo sube al servidor y lo publica con el comando oficial (license-admin publicar-apk).
#   3. Comprueba que lo guardado en el servidor es IDENTICO al de tu PC.
#   4. Prueba de punta a punta: crea una licencia de cortesia temporal, genera su link personal, baja el APK por ese
#      link, compara, y revoca la licencia temporal.
#   5. Si la copia publica sigue online, te pide escribir SI y la MUEVE (no la borra) a /root/apk-publico-respaldo/.

param(
  [string]$Vps = 'root@66.97.38.36',
  [string]$Url = 'https://lite.zscore.ar',
  [string]$Apk = (Join-Path $PSScriptRoot 'android\app\build\outputs\apk\release\app-release.apk'),
  [string]$Notas = 'Activacion con codigo de licencia|Aviso cuando hay una version nueva, con sus novedades|Mejoras y correcciones',
  [string]$ApkPublico = '/var/www/zscore/lite/descargar/zscore-lite.apk',
  [switch]$NoRetirarPublico
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Huella del certificado de release (zscore-release.jks). Si el APK esta firmado con otra cosa, no se publica.
$CertEsperado = '6e65e3afd32c9ae8dad888f7bc168f5429e3a1821deb5c414a805a1f5c1f0b5d'
$Admin = 'cd /var/www/zscore/license-server && DATA_DIR=/var/www/zscore/license-data sudo -E -u www-data node license-admin.cjs'

function Paso($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  OK  $t" -ForegroundColor Green }
function Aviso($t) { Write-Host "  !!  $t" -ForegroundColor Yellow }
function Verificar($t) { if ($LASTEXITCODE -ne 0) { throw "Fallo: $t (codigo $LASTEXITCODE). No se siguio." } }
function Remoto($cmd) {
  $salida = ssh $Vps $cmd
  if ($LASTEXITCODE -ne 0) { throw "Fallo en el servidor al ejecutar: $cmd" }
  return $salida
}

# ---------- 1. Revisar el APK en tu PC ----------
Paso 'Revisando el APK en tu PC'
if (-not (Test-Path $Apk)) { throw "No encuentro el APK: $Apk (compilalo primero)" }
$gradle = Get-Content (Join-Path $PSScriptRoot 'android\app\build.gradle') -Raw
if ($gradle -notmatch 'versionCode\s+(\d+)') { throw 'No encontre versionCode en android\app\build.gradle' }
$codigo = [int]$Matches[1]
if ($gradle -notmatch 'versionName\s+"([^"]+)"') { throw 'No encontre versionName en android\app\build.gradle' }
$nombre = $Matches[1]
$hashLocal = (Get-FileHash $Apk -Algorithm SHA256).Hash.ToLower()
$mb = [math]::Round((Get-Item $Apk).Length / 1MB, 1)
Ok "APK $nombre (codigo $codigo), $mb MB, sha256 $($hashLocal.Substring(0, 16))..."

$sdk = $env:ANDROID_HOME
$apksigner = $null
if ($sdk -and (Test-Path (Join-Path $sdk 'build-tools'))) {
  $apksigner = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory | Sort-Object { [version]($_.Name -replace '[^0-9.].*$', '') } -ErrorAction SilentlyContinue |
    Select-Object -Last 1 | ForEach-Object { Join-Path $_.FullName 'apksigner.bat' }
}
if ($apksigner -and (Test-Path $apksigner)) {
  $firma = & $apksigner verify --print-certs $Apk 2>&1 | Out-String
  if ($firma -notmatch 'certificate SHA-256 digest:\s*([0-9a-fA-F]+)') { throw 'No pude leer la firma del APK (apksigner).' }
  if ($Matches[1].ToLower() -ne $CertEsperado) { throw "El APK NO esta firmado con tu clave de release (huella $($Matches[1])). No se publica." }
  Ok 'firmado con tu clave de release (zscore-release.jks)'
} else {
  Aviso 'No encontre apksigner: no pude comprobar la firma (el APK se compilo ya firmado con tu clave).'
}

# ---------- 2. Subir y publicar ----------
Paso 'Subiendo el APK al servidor'
scp $Apk "${Vps}:/tmp/zscore-lite-subir.apk"
Verificar 'subir el APK'
Remoto 'chmod 644 /tmp/zscore-lite-subir.apk' | Out-Null

Paso 'Publicando (descarga protegida)'
$publicar = "$Admin publicar-apk /tmp/zscore-lite-subir.apk --nombre $nombre --codigo $codigo --notas '$Notas'"
Remoto $publicar | ForEach-Object { Write-Host "  $_" }

# ---------- 3. Comprobar que es identico ----------
Paso 'Comprobando que el servidor guardo lo mismo'
$hashRemoto = ((Remoto 'sha256sum /var/www/zscore/license-data/apk/zscore-lite.apk') -split '\s+')[0].ToLower()
if ($hashRemoto -ne $hashLocal) { throw "El APK guardado en el servidor NO coincide con el tuyo (servidor $hashRemoto, tu PC $hashLocal)." }
Ok 'el APK del servidor es identico al de tu PC'
Remoto 'rm -f /tmp/zscore-lite-subir.apk' | Out-Null

# ---------- 4. Prueba de punta a punta con una licencia temporal ----------
Paso 'Prueba de descarga protegida (licencia temporal)'
$codigoPrueba = $null
$tmp = Join-Path $env:TEMP 'zscore-lite-verificacion.apk'
try {
  $creada = (Remoto "$Admin crear --tipo cortesia --nota 'verificacion de descarga (se revoca sola)'") -join "`n"
  if ($creada -notmatch '(ZSL-[A-Z0-9]{4}-[A-Z0-9]{4})') { throw 'No pude crear la licencia temporal.' }
  $codigoPrueba = $Matches[1]
  $enlace = (Remoto "$Admin link $codigoPrueba --horas 1 --usos 1") -join "`n"
  if ($enlace -notmatch '(https?://\S+)') { throw 'No pude generar el link de descarga.' }
  $link = $Matches[1]
  $estado = curl.exe -s -o $tmp -w '%{http_code}' $link
  if ($estado -ne '200') { throw "El link personal respondio $estado en vez de 200." }
  $hashBajado = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
  if ($hashBajado -ne $hashLocal) { throw 'Lo que baja el link personal NO es el APK correcto.' }
  Ok 'el link personal baja el APK correcto'
  $segundo = curl.exe -s -o NUL -w '%{http_code}' $link
  if ($segundo -eq '200') { throw 'El link de 1 uso se pudo usar dos veces.' }
  Ok "el mismo link ya no sirve una segunda vez (responde $segundo)"
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
  if ($codigoPrueba) {
    ssh $Vps "$Admin revocar $codigoPrueba" | Out-Null
    Ok "licencia temporal $codigoPrueba revocada"
  }
}

# ---------- 5. Retirar la copia publica ----------
Paso 'Copia publica del APK'
$estadoPublico = curl.exe -s -o NUL -w '%{http_code}' -I "$Url/descargar/zscore-lite.apk"
if ($estadoPublico -ne '200') {
  Ok "no hay copia publica online (el link publico responde $estadoPublico)"
} elseif ($NoRetirarPublico) {
  Aviso 'La copia publica sigue online (pediste no retirarla). Mientras tanto cualquiera puede bajar el APK sin licencia.'
} else {
  Write-Host "  El APK sigue bajandose gratis desde $Url/descargar/zscore-lite.apk" -ForegroundColor Yellow
  Write-Host '  Se va a MOVER (no borrar) a /root/apk-publico-respaldo/ en el servidor, por si queres volver atras.'
  $resp = Read-Host '  Escribi SI para retirarla'
  if ($resp -ne 'SI') {
    Aviso 'No se retiro. Cuando quieras: .\publicar-apk.ps1 (te lo vuelve a preguntar).'
  } else {
    $existe = ssh $Vps "test -f $ApkPublico && echo si || echo no"
    if ($existe -ne 'si') {
      Aviso "No encontre el archivo en $ApkPublico. Mira donde esta con:"
      Write-Host "      ssh $Vps `"grep -rn 'descargar' /etc/nginx/sites-available/`""
      Write-Host '  y pasame la salida.'
    } else {
      Remoto "mkdir -p /root/apk-publico-respaldo && mv $ApkPublico /root/apk-publico-respaldo/zscore-lite-publico.apk" | Out-Null
      $despues = curl.exe -s -o NUL -w '%{http_code}' -I "$Url/descargar/zscore-lite.apk"
      if ($despues -eq '200') { Aviso 'Se movio el archivo pero el link publico sigue respondiendo 200: puede haber otra copia o cache. Pasame esta salida.' }
      else { Ok "copia publica retirada (el link publico ahora responde $despues). Respaldo en /root/apk-publico-respaldo/" }
    }
  }
}

Paso 'Listo'
Write-Host "APK $nombre publicado con descarga protegida. Panel: $Url/admin (pestana App (APK))."
