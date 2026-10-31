# Baja el motor de voz (sherpa-onnx) que usa la app Android. El .aar pesa ~49 MB y no se guarda en git.
$dest = Join-Path $PSScriptRoot 'android\app\libs\sherpa-onnx-2.0.1.aar'
if (Test-Path $dest) { Write-Host 'Ya esta: ' $dest; return }
New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
curl.exe -L -o $dest 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-2.0.1.aar'
