#!/usr/bin/env bash
# Fase 2: instala el servicio de licencias en el VPS. Se corre UNA vez, como root, en el VPS.
#
#   bash install-license.sh /ruta/a/license-private.pem      (la primera vez)
#   bash install-license.sh                                   (para actualizar: reusa la clave ya instalada)
#
# Qué hace (se puede repetir sin romper nada):
#   - copia el código a /var/www/zscore/license-server/ y la clave a /var/www/zscore/license-data/
#   - instala y arranca el servicio systemd zscore-license (solo 127.0.0.1:3721)
#   - copia la página del panel (/admin) y agrega a nginx los bloques /api/license y /admin + /api/admin
#     (con copia de seguridad y marcha atrás si nginx rechaza el cambio)
# Qué NO hace: no prende LICENSE_REQUIRED, no toca el APK público, no toca el servicio del partido en vivo.

set -euo pipefail

KEY_SRC="${1:-}"
SRC="$(cd "$(dirname "$0")" && pwd)"
BASE=/var/www/zscore
CODE_DIR="$BASE/license-server"
DATA_DIR="$BASE/license-data"
VHOST="${VHOST:-/etc/nginx/sites-available/lite.zscore.ar}"
SERVICE=/etc/systemd/system/zscore-license.service
# Todos los license-*.cjs de la carpeta: así un módulo nuevo no puede quedar sin copiar (pasó con license-pay.cjs).
FILES=()
for f in "$SRC"/license-*.cjs; do FILES+=("$(basename "$f")"); done
PANEL_FILES=(admin.html admin.css admin.js)
PREV="$CODE_DIR.anterior"
SERVICE_PREV="$SERVICE.anterior"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

say "Revisando requisitos"
[ "$(id -u)" -eq 0 ] || die "correlo como root"
if [ -z "$KEY_SRC" ] && [ -f "$DATA_DIR/license-private.pem" ]; then KEY_SRC="$DATA_DIR/license-private.pem"; fi
[ -n "$KEY_SRC" ] && [ -f "$KEY_SRC" ] || die "uso: bash install-license.sh /ruta/a/license-private.pem"
command -v node >/dev/null || die "no hay node en el servidor"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || die "hace falta Node 18 o más (hay $(node -v))"
id www-data >/dev/null 2>&1 || die "no existe el usuario www-data"
[ -f "$VHOST" ] || die "no encuentro $VHOST (si se llama distinto: VHOST=/ruta bash install-license.sh ...)"
for f in license-server.cjs license-lib.cjs license-ops.cjs license-panel.cjs license-pay.cjs license-mail.cjs license-texts.cjs license-admin.cjs zscore-license.service nginx-license.conf nginx-admin.conf; do [ -f "$SRC/$f" ] || die "falta $SRC/$f"; done
for f in "${PANEL_FILES[@]}"; do [ -f "$SRC/panel/$f" ] || die "falta $SRC/panel/$f"; done
openssl pkey -in "$KEY_SRC" -noout 2>/dev/null || die "la clave no se puede leer como PEM"
echo "node $(node -v), clave legible"
echo "Clave pública que corresponde a esta clave privada (tiene que ser IGUAL a PUBLIC_KEY_B64 de www/js/license.js):"
openssl pkey -in "$KEY_SRC" -pubout -outform DER | base64 -w0; echo

say "Copiando archivos"
mkdir -p "$CODE_DIR" "$DATA_DIR"
# Copia de lo que hay ahora, para volver atrás si el servicio nuevo no arranca.
rm -rf "$PREV"; cp -a "$CODE_DIR" "$PREV"
if [ -f "$SERVICE" ]; then cp -a "$SERVICE" "$SERVICE_PREV"; fi
for f in "${FILES[@]}"; do install -m 644 "$SRC/$f" "$CODE_DIR/$f"; done
mkdir -p "$CODE_DIR/panel"
for f in "${PANEL_FILES[@]}"; do install -m 644 "$SRC/panel/$f" "$CODE_DIR/panel/$f"; done
if [ -f "$DATA_DIR/license-private.pem" ] && ! cmp -s "$KEY_SRC" "$DATA_DIR/license-private.pem"; then
  die "ya hay OTRA clave en $DATA_DIR/license-private.pem; no la piso. Revisá a mano."
fi
[ "$KEY_SRC" -ef "$DATA_DIR/license-private.pem" ] || install -m 600 "$KEY_SRC" "$DATA_DIR/license-private.pem"
chown -R www-data:www-data "$CODE_DIR" "$DATA_DIR"
chmod 700 "$DATA_DIR"

# Si algo sale mal después de copiar, se deja el servicio como estaba antes.
rollback() {
  echo "Volviendo a la versión anterior del servicio..." >&2
  if [ -d "$PREV" ]; then rm -rf "$CODE_DIR"; cp -a "$PREV" "$CODE_DIR"; fi
  if [ -f "$SERVICE_PREV" ]; then cp -a "$SERVICE_PREV" "$SERVICE"; fi
  systemctl daemon-reload
  systemctl restart zscore-license || true
  if systemctl is-active --quiet zscore-license; then echo "El servicio anterior quedó funcionando." >&2; else echo "OJO: el servicio anterior tampoco arrancó; revisá: journalctl -u zscore-license -n 30" >&2; fi
}

say "Servicio systemd"
# Antes de reiniciar: que todos los módulos se puedan cargar (esto atrapa un archivo que falte).
for f in "${FILES[@]}"; do
  case "$f" in license-server.cjs|license-admin.cjs) continue ;; esac
  DATA_DIR="$DATA_DIR" PRIVATE_KEY_FILE="$DATA_DIR/license-private.pem" node -e "require('$CODE_DIR/$f')" 2>/tmp/zs-require.err     || { cat /tmp/zs-require.err >&2; rollback; die "no se puede cargar $f; no se reinició el servicio nuevo"; }
done
install -m 644 "$SRC/zscore-license.service" "$SERVICE"
systemctl daemon-reload
systemctl enable zscore-license >/dev/null 2>&1
systemctl restart zscore-license
sleep 1
systemctl is-active --quiet zscore-license || { journalctl -u zscore-license -n 20 --no-pager; rollback; die "el servicio nuevo no arrancó"; }
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"code":"ZSL-NOPE-NOPE","device":"instalacion-prueba"}' http://127.0.0.1:3721/api/license/activar)
[ "$code" = "404" ] || { rollback; die "el servicio respondió $code en vez de 404 (código inexistente)"; }
echo "servicio activo y respondiendo"

say "nginx"
# Agrega un bloque (archivo $2) al vhost si todavía no está ($1 es lo que se busca para saberlo).
add_block() {
  local marker="$1" file="$2" backup anchor block
  if grep -q "$marker" "$VHOST"; then
    echo "el bloque de $marker ya está en $VHOST; no se toca"
    return 0
  fi
  anchor=$(grep -n 'location ~ \^/api/live' "$VHOST" | head -1 | cut -d: -f1 || true)
  if [ -z "$anchor" ]; then
    echo "No encontré el bloque de /api/live en $VHOST."
    echo "Pegá a mano el contenido de $SRC/$file dentro del server de 443, y luego: nginx -t && systemctl reload nginx"
    return 0
  fi
  backup="$VHOST.antes-$(basename "$file" .conf).$(date +%Y%m%d%H%M%S)"
  cp -p "$VHOST" "$backup"
  block=$(grep -v '^#' "$SRC/$file")
  awk -v n="$anchor" -v block="$block" 'NR==n { print block; print "" } { print }' "$backup" > "$VHOST"
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    echo "bloque de $marker agregado y nginx recargado (copia: $backup)"
  else
    cp -p "$backup" "$VHOST"
    nginx -t || true
    die "nginx rechazó el cambio; dejé $VHOST como estaba. Agregá el bloque de $file a mano."
  fi
}
add_block '/api/license' nginx-license.conf
add_block 'api/admin' nginx-admin.conf

say "Listo"
echo "Probá desde afuera:  curl -i -X POST https://lite.zscore.ar/api/license/activar -H 'Content-Type: application/json' -d '{\"code\":\"ZSL-NOPE-NOPE\",\"device\":\"prueba-externa\"}'"
echo "Debe devolver 404 con {\"error\":\"codigo\"}. La app sigue sin pedir licencia (LICENSE_REQUIRED=false) y el APK público sigue donde estaba."
if [ ! -f "$DATA_DIR/admin.json" ]; then
  echo
  echo "PANEL: falta crear la contraseña (se pide sin mostrarla; mínimo 12 caracteres):"
  echo "  ssh -t root@<vps> 'cd $CODE_DIR && DATA_DIR=$DATA_DIR sudo -E -u www-data node license-admin.cjs panel-clave'"
fi
echo "Panel: https://lite.zscore.ar/admin"
