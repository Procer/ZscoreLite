# Servidor del partido en vivo

Servicio Node chico (sin dependencias) que guarda el último estado de cada
partido transmitido y se lo reparte al público en tiempo real (SSE).
Lo usan `www/js/live.js` (el marcador publica) y `www/ver.html` (el público mira).

## Qué toca en el VPS

Todo queda dentro de `/var/www/zscore/`, salvo dos archivos de configuración:

| Qué | Dónde |
|---|---|
| Código del servicio | `/var/www/zscore/live-server/live-server.cjs` |
| Datos (se borran solos a las 8 h sin novedades) | `/var/www/zscore/live-data/` |
| Servicio systemd | `/etc/systemd/system/zscore-live.service` |
| Bloque de nginx (solo `/api/live`) | `/etc/nginx/sites-available/zscorelite.anka.ar` |

No usa PM2 ni toca ningún otro sitio. Escucha solo en `127.0.0.1:3720`.

## Instalación

```bash
# 1. archivos
mkdir -p /var/www/zscore/live-server /var/www/zscore/live-data
cp live-server.cjs /var/www/zscore/live-server/
chown -R www-data:www-data /var/www/zscore/live-server /var/www/zscore/live-data

# 2. servicio
cp zscore-live.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now zscore-live
curl -s -X POST http://127.0.0.1:3720/api/live      # debe devolver {"code":...,"token":...}

# 3. nginx: agregar el bloque de nginx-live.conf, luego
nginx -t && systemctl reload nginx
```

## Desinstalar

```bash
systemctl disable --now zscore-live
rm /etc/systemd/system/zscore-live.service
# quitar el bloque `location ~ ^/api/live` del vhost y: nginx -t && systemctl reload nginx
rm -r /var/www/zscore/live-server /var/www/zscore/live-data
```

## API

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/live` | crea una transmisión → `{ code, token }` |
| PUT | `/api/live/:code` | publica el estado (header `x-token`) |
| GET | `/api/live/:code` | último estado |
| GET | `/api/live/:code/stream` | estado en vivo (SSE) |
| DELETE | `/api/live/:code` | termina la transmisión (header `x-token`) |

Límites: 20 transmisiones nuevas por hora por IP, 500 simultáneas, 16 KB por
envío, 400 espectadores conectados a la vez (12 por IP).

## Prueba local

```bash
PORT=3722 DATA_DIR=./data STATIC_DIR=../www node live-server.cjs
# abrir http://127.0.0.1:3722/
```

---

# Servicio de licencias

`license-server.cjs` (el servicio), `license-lib.cjs` (código compartido) y
`license-admin.cjs` (comando para crear y administrar licencias). Contrato con
la app: `www/js/license.js`. Escucha solo en `127.0.0.1:3721`; no usa PM2.

| Qué | Dónde |
|---|---|
| Código | `/var/www/zscore/license-server/` (los tres `license-*.cjs`) |
| Datos: `licenses.json` y la clave PRIVADA `license-private.pem` | `/var/www/zscore/license-data/` (sin acceso web, modo 700) |
| Servicio systemd | `/etc/systemd/system/zscore-license.service` |
| Bloque de nginx (solo `/api/license`) | `/etc/nginx/sites-available/zscorelite.anka.ar` |

## Instalación

```bash
mkdir -p /var/www/zscore/license-server /var/www/zscore/license-data
cp license-server.cjs license-lib.cjs license-admin.cjs /var/www/zscore/license-server/
# la clave privada se copia a mano desde C:\Users\<usuario>\zscore-keys\license-private.pem (NUNCA al repo)
cp license-private.pem /var/www/zscore/license-data/
chown -R www-data:www-data /var/www/zscore/license-server /var/www/zscore/license-data
chmod 700 /var/www/zscore/license-data && chmod 600 /var/www/zscore/license-data/license-private.pem

cp zscore-license.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now zscore-license
# nginx: agregar el bloque de nginx-license.conf, luego: nginx -t && systemctl reload nginx
```

## Uso diario (en el VPS)

```bash
cd /var/www/zscore/license-server
export DATA_DIR=/var/www/zscore/license-data
sudo -E -u www-data node license-admin.cjs crear --tipo paga --dias 30 --nota "Club Ejemplo"
sudo -E -u www-data node license-admin.cjs crear --tipo cortesia --nota "Juan"
sudo -E -u www-data node license-admin.cjs listar
sudo -E -u www-data node license-admin.cjs extender ZSL-XXXX-XXXX 30     # tras un pago
sudo -E -u www-data node license-admin.cjs resetear ZSL-XXXX-XXXX        # cambio de celular
sudo -E -u www-data node license-admin.cjs revocar ZSL-XXXX-XXXX
```

Un token dura 32 días y la app lo renueva sola; revocar o dejar vencer una
licencia se nota cuando el token vigente de ese celular llega a su fin (+3 días de gracia).

## Descarga protegida del APK

El APK ya no se publica en una ruta abierta: vive en `license-data/apk/` y solo se entrega
con un link personal (vence, tiene tope de descargas y solo sirve si la licencia está al día).

```bash
# Publicar (o actualizar) el APK vigente. El nombre y el código salen de android/app/build.gradle
# (versionName / versionCode); el APK de release es android/app/build/outputs/apk/release/app-release.apk
node license-admin.cjs publicar-apk /ruta/app-release.apk --nombre 1.5 --codigo 6 \
  --notas "Qué cambia 1|Qué cambia 2|Qué cambia 3"
# --notas: las novedades que el cliente lee antes de actualizar (líneas separadas con |, hasta 10, texto plano)

# Link personal para mandar por WhatsApp (por defecto 48 h y 3 descargas)
node license-admin.cjs link ZSL-XXXX-XXXX [--horas 48] [--usos 3]
```

Las apps instaladas con licencia al día preguntan al abrir si hay una versión más nueva y muestran
"Hay una versión nueva" con un botón que abre la descarga (link de 15 minutos). Sin licencia vigente
no se enteran. **Para que el APK deje de ser público hay que borrar `/var/www/zscore/lite/descargar/zscore-lite.apk`
del VPS** (paso aparte, con confirmación) y, si existe, el link a esa ruta en la web.
