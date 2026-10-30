# Cambia MP_ACCESS_TOKEN en el servidor sin mostrarlo ni guardarlo en tu PC.
#   .\cambiar-token-mp.ps1                 (para cambiar tambien la clave secreta del webhook: -Secreto)
param([switch]$Secreto, [switch]$SoloSecreto,[string]$Vps = 'root@66.97.38.36')

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Leer($pedido) {
  $s = Read-Host $pedido -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

scp "$PSScriptRoot\server\set-env-var.sh" "${Vps}:/root/set-env-var.sh"
if ($LASTEXITCODE -ne 0) { throw 'No se pudo subir el ayudante.' }

if (-not $SoloSecreto) {
  $tok = Leer 'Pega el ACCESS TOKEN (el largo, no la Public Key) y Enter'
  $tok | ssh $Vps "bash /root/set-env-var.sh MP_ACCESS_TOKEN 60"
}

if ($Secreto -or $SoloSecreto) {
  $sec = Leer 'Pega la CLAVE SECRETA del webhook y Enter'
  $sec | ssh $Vps "bash /root/set-env-var.sh MP_WEBHOOK_SECRET 10"
}

ssh $Vps "rm -f /root/set-env-var.sh; systemctl restart zscore-license; systemctl is-active zscore-license"
