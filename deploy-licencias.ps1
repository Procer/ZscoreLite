# Sube el servicio de licencias y el panel al VPS, los instala y verifica desde afuera.
#
#   .\deploy-licencias.ps1                 (corre los tests, sube, instala y prueba)
#   .\deploy-licencias.ps1 -SinTests       (salta los tests)
#
# No toca la clave privada (ya está instalada), no prende la licencia obligatoria y no borra el APK público.
# Para cargar las credenciales de Mercado Pago o crear la contraseña del panel, ver server/README.md.

param(
  [string]$Vps = 'root@66.97.38.36',
  [string]$Url = 'https://lite.zscore.ar',
  [switch]$SinTests
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Paso($texto) { Write-Host "`n== $texto" -ForegroundColor Cyan }
function Verificar($texto) { if ($LASTEXITCODE -ne 0) { throw "Falló: $texto (código $LASTEXITCODE). No se siguió." } }

if (-not $SinTests) {
  Paso 'Tests (47 esperados)'
  npm test
  Verificar 'los tests'
}

Paso 'Subiendo archivos'
ssh $Vps 'mkdir -p /root/lic-install'
Verificar 'crear la carpeta en el servidor'
scp -r server/license-server.cjs server/license-lib.cjs server/license-ops.cjs server/license-panel.cjs server/license-pay.cjs server/license-admin.cjs server/panel server/zscore-license.service server/nginx-license.conf server/nginx-admin.conf server/install-license.sh "${Vps}:/root/lic-install/"
Verificar 'subir los archivos'

Paso 'Instalando (reusa la clave ya instalada)'
ssh $Vps 'bash /root/lic-install/install-license.sh'
Verificar 'el instalador'

Paso 'Verificando desde afuera'
$cuerpo = '{"code":"ZSL-NOPE-NOPE","device":"verificacion-deploy"}'
$licencia = curl.exe -s -o NUL -w '%{http_code}' -X POST "$Url/api/license/activar" -H 'Content-Type: application/json' -d $cuerpo.Replace('"', '\"')
$panel = curl.exe -s -o NUL -w '%{http_code}' "$Url/admin"
$sesion = curl.exe -s "$Url/api/admin/session"
Write-Host "licencias (esperado 404): $licencia"
Write-Host "panel /admin (esperado 200): $panel"
Write-Host "sesión del panel: $sesion"
if ($licencia -ne '404' -or $panel -ne '200') { throw 'La verificación externa no dio lo esperado: revisá nginx y el servicio (journalctl -u zscore-license -n 30).' }

Paso 'Listo'
Write-Host "Panel: $Url/admin  (usuario admin)"
Write-Host 'La app sigue sin exigir licencia y el APK público sigue donde estaba.'
