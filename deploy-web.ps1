# Publica la app web (carpeta www) y/o la pagina de inicio (carpeta sitio-lite) en el servidor.
#
#   .\deploy-web.ps1 -App       publica la app en https://lite.zscore.ar/app/   (carpeta www)
#   .\deploy-web.ps1 -Sitio     publica la pagina de inicio https://lite.zscore.ar/   (carpeta sitio-lite)
#   .\deploy-web.ps1 -App -Sitio
#
# Antes de pisar nada guarda una copia en el servidor (app.anterior / index.html.anterior).
# -Sitio saca el link directo al APK publico y pone el boton "Comprar licencia": hacelo DESPUES de
# .\publicar-apk.ps1 y de cargar el precio en el panel (pestana Cobros).

param(
  [switch]$App,
  [switch]$Sitio,
  [string]$Vps = 'root@66.97.38.36',
  [string]$Url = 'https://lite.zscore.ar',
  [string]$Raiz = '/var/www/zscore/lite'
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Paso($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  OK  $t" -ForegroundColor Green }
function Verificar($t) { if ($LASTEXITCODE -ne 0) { throw "Fallo: $t (codigo $LASTEXITCODE). No se siguio." } }

if (-not ($App -or $Sitio)) { throw 'Indica que publicar: -App (la app) y/o -Sitio (la pagina de inicio).' }
$sitioDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'sitio-lite'

Paso 'Revisando el servidor'
$hay = ssh $Vps "test -f $Raiz/index.html && test -f $Raiz/app/index.html && echo si || echo no"
if ($hay -ne 'si') {
  Write-Host "No encuentro $Raiz/index.html y $Raiz/app/index.html en el servidor." -ForegroundColor Yellow
  Write-Host 'No se toco nada. Pasame la salida de este comando y lo ajusto:'
  Write-Host "  ssh $Vps `"grep -n 'root|location|proxy_pass' /etc/nginx/sites-available/lite.zscore.ar`""
  throw 'Carpeta del sitio no encontrada.'
}
Ok "carpeta del sitio encontrada: $Raiz"

if ($App) {
  Paso 'Publicando la app (carpeta www)'
  ssh $Vps "rm -rf $Raiz/app.anterior && cp -a $Raiz/app $Raiz/app.anterior"
  Verificar 'guardar la copia anterior de la app'
  scp -r www/* "${Vps}:$Raiz/app/"
  Verificar 'subir la app'
  ssh $Vps "chmod -R a+rX $Raiz/app"
  Verificar 'dar permisos'
  $licencia = curl.exe -s "$Url/app/js/license.js"
  if ($licencia -notmatch 'startTrial') { throw 'La app publicada no tiene la prueba gratis: algo no se subio bien (o hay cache).' }
  Ok 'la app publicada tiene el codigo de licencias y la prueba gratis'
  Write-Host "  (copia anterior en el servidor: $Raiz/app.anterior)"
}

if ($Sitio) {
  Paso 'Publicando la pagina de inicio (carpeta sitio-lite)'
  if (-not (Test-Path (Join-Path $sitioDir 'index.html'))) { throw "No encuentro $sitioDir\index.html" }
  Write-Host '  Esto saca el link directo al APK publico y pone el boton "Comprar licencia".' -ForegroundColor Yellow
  $resp = Read-Host '  Escribi SI para continuar'
  if ($resp -ne 'SI') { throw 'Cancelado: no se publico la pagina de inicio.' }
  ssh $Vps "cp -a $Raiz/index.html $Raiz/index.html.anterior"
  Verificar 'guardar la copia anterior de la pagina'
  scp (Join-Path $sitioDir 'index.html') "${Vps}:$Raiz/index.html"
  Verificar 'subir la pagina'
  if (Test-Path (Join-Path $sitioDir 'img')) {
    ssh $Vps "mkdir -p $Raiz/img"
    scp -r (Join-Path $sitioDir 'img\*') "${Vps}:$Raiz/img/"
    Verificar 'subir las imagenes'
  }
  ssh $Vps "chmod -R a+rX $Raiz/index.html $Raiz/img"
  $pagina = curl.exe -s "$Url/"
  if ($pagina -notmatch 'Comprar licencia') { throw 'La pagina publicada no tiene el boton Comprar licencia: algo no se subio bien (o hay cache).' }
  if ($pagina -match 'descargar/zscore-lite\.apk') { throw 'La pagina publicada todavia enlaza al APK publico.' }
  Ok 'pagina de inicio publicada con el boton "Comprar licencia" y sin el link al APK publico'
  Write-Host "  (copia anterior en el servidor: $Raiz/index.html.anterior)"
}

Paso 'Listo'
Write-Host "Mira: $Url/  y  $Url/app/"
