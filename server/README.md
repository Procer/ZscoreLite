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
