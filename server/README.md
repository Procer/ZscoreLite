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
| Bloque de nginx (solo `/api/live`) | `/etc/nginx/sites-available/lite.zscore.ar` |

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
| Código | `/var/www/zscore/license-server/` (los `license-*.cjs`) |
| Datos: `licenses.json` y la clave PRIVADA `license-private.pem` | `/var/www/zscore/license-data/` (sin acceso web, modo 700) |
| Servicio systemd | `/etc/systemd/system/zscore-license.service` |
| Bloque de nginx (solo `/api/license`) | `/etc/nginx/sites-available/lite.zscore.ar` |

## Instalación

```bash
mkdir -p /var/www/zscore/license-server /var/www/zscore/license-data
cp license-server.cjs license-lib.cjs license-ops.cjs license-admin.cjs /var/www/zscore/license-server/
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
sudo -E -u www-data node license-admin.cjs crear --tipo paga --cliente "Club Sur" --contacto "11-5555-0000" --precio 15000 --moneda ARS
sudo -E -u www-data node license-admin.cjs editar ZSL-XXXX-XXXX --cliente "Club Sur SA"
sudo -E -u www-data node license-admin.cjs convertir ZSL-XXXX-XXXX --dias 30      # prueba/cortesía a paga
sudo -E -u www-data node license-admin.cjs dispositivos ZSL-XXXX-XXXX 2
sudo -E -u www-data node license-admin.cjs ver ZSL-XXXX-XXXX                       # incluye el historial
```

Cada cambio queda en el historial de la licencia (quién y cuándo). `licenses.json` es la base:
se escribe bajo un archivo de bloqueo (`licenses.json.lock`), así el servicio y los comandos pueden
trabajar a la vez sin perder cambios. Si el archivo no se puede leer, nada lo pisa y los comandos
avisan. Al actualizar desde el esquema v1 se guarda una copia `licenses.json.v1-<fecha>.bak`.

## Pruebas

```bash
npm test      # node --test "server/test/*.test.cjs": usa carpeta y clave temporales, no toca datos reales
```

Un token dura 32 días y la app lo renueva sola; revocar o dejar vencer una
licencia se nota cuando el token vigente de ese celular llega a su fin (+3 días de gracia).

## Panel de administración (/admin)

Lo atiende el mismo servicio (`license-panel.cjs` y la carpeta `panel/`). Página en `https://lite.zscore.ar/admin`,
API en `/api/admin`. Qué hay: resumen con lo que hay que atender, tabla de licencias con búsqueda y filtros,
ficha con historial (extender, convertir, revocar, liberar dispositivo, link de descarga, datos del cliente)
y publicación del APK.

```bash
# Cambiarla con la sesión abierta: botón "Contraseña" del panel (pide la actual).
# Si se olvidó, crear una nueva desde el servidor (se pide sin mostrarla, mínimo 12 caracteres; -t para tener terminal)
ssh -t root@66.97.38.36 'cd /var/www/zscore/license-server && DATA_DIR=/var/www/zscore/license-data sudo -E -u www-data node license-admin.cjs panel-clave'
systemctl restart zscore-license      # cierra las sesiones abiertas (están en memoria)
```

Seguridad: contraseña con scrypt en `license-data/admin.json` (modo 600); cookie `HttpOnly` + `Secure` + `SameSite=Strict`;
sesión de 30 min sin uso y 12 h máximo; token CSRF en cada cambio; 5 intentos fallidos por IP cada 15 min; la página
va con CSP estricta. Opcional: limitar por IP en nginx (líneas `allow`/`deny` comentadas en `nginx-admin.conf`).
Los cambios hechos desde el panel quedan en el historial con actor `panel`.

`bash install-license.sh` (sin argumentos, desde la carpeta con los archivos subidos) actualiza el servicio y agrega
el bloque de nginx del panel si falta.

## Venta online automática (Mercado Pago + email)

Módulos `license-pay.cjs` (cobro), `license-mail.cjs` (envío por SMTP) y `license-texts.cjs` (textos de los emails).

**Qué pasa cuando alguien compra**

1. El cliente abre `https://lite.zscore.ar/api/license/comprar` (el botón "Comprar" del sitio) y paga en Mercado Pago.
2. Mercado Pago avisa a `https://lite.zscore.ar/api/license/pago`. El servicio valida la firma, le pregunta el pago a
   Mercado Pago y comprueba referencia, moneda y monto. Un mismo pago nunca se aplica dos veces.
3. Se **crea una licencia paga** (nombre y email del pagador, precio, 30 días) y se le manda por email el código, el
   vencimiento, un link de descarga personal y los pasos. A vos te llega un aviso a "Email para avisos".
4. En el panel, pestaña **Cobros**, queda registrado: quién pagó, cuánto, qué licencia, hasta cuándo vence y si el email salió.
5. Unos días antes de vencer (5 por defecto) el cliente recibe un email con un link para renovar; al pagar, la licencia se
   extiende sola y recibe el recibo. No hay débito automático: cada período es un pago nuevo.

Si el email falla (correo caído) se reintenta solo; si el pagador no dejó email, aparece en "Emails de compra sin enviar"
del Resumen y se manda a mano desde la ficha ("Enviar instrucciones por email"). Reintegros y contracargos se anotan para
revisar a mano; no cortan la licencia solos. El precio, los días y el email para avisos se cargan en el panel (Cobros).

### Activarlo, paso a paso

**A. Mercado Pago** (con la cuenta que va a cobrar, con la identidad verificada)

1. Entrá a https://www.mercadopago.com.ar/developers e ingresá con tu cuenta.
2. "Tus integraciones" > "Crear aplicación". Nombre: Z-Score Lite. Solución de pago: **Checkout Pro**.
3. En la aplicación, "Credenciales de prueba": copiá el **Access Token** (empieza con `APP_USR-`).
4. En la aplicación, menú izquierdo "Webhooks" > "Configurar notificaciones": modo **pruebas**, URL
   `https://lite.zscore.ar/api/license/pago`, evento **Pagos**, guardar. Copiá la **clave secreta** que aparece.
5. En "Cuentas de prueba" creá un comprador de prueba (y mirá las "Tarjetas de prueba" de Argentina).

**B. Correo** (para mandar los emails). Opción simple con Gmail:

1. Usá una cuenta de Gmail (idealmente una nueva solo para esto, por ejemplo `zscorelicencias@gmail.com`).
2. Activá la verificación en 2 pasos de esa cuenta y creá una **contraseña de aplicación** (Cuenta de Google > Seguridad >
   Contraseñas de aplicaciones). Copiá los 16 caracteres.
3. Si tenés correo con tu dominio (por ejemplo `licencias@zscore.ar`), usá en su lugar los datos SMTP que te da el hosting.

**C. Cargar los datos en el servidor** (una vez; nunca en el repo ni en el chat):

```bash
install -m 600 /dev/null /etc/zscore-license.env
nano /etc/zscore-license.env     # copiar el contenido de server/zscore-license.env.example y completarlo
systemctl restart zscore-license
```

**D. Probar** (todavía con credenciales de **prueba**)

1. Panel > Cobros: las dos etiquetas tienen que decir "listo". Cargá el precio y el email para avisos, guardá y tocá
   "Enviar email de prueba": te tiene que llegar.
2. Abrí el link de compra en una ventana privada, entrá con el **comprador de prueba** y pagá con una tarjeta de prueba.
3. En un minuto: aparece el pago en Cobros, se creó la licencia y llegaron los dos emails (cliente y aviso).

**E. Pasar a producción**: en la aplicación de Mercado Pago, "Credenciales de producción" (Access Token) y, en Webhooks, el
modo **producción** con la misma URL (aparece otra clave secreta). Cambiá los dos valores en `/etc/zscore-license.env` y
`systemctl restart zscore-license`. Hacé una compra real chica para comprobar.

El token, la clave secreta y la contraseña de correo no se guardan en la base ni salen por la API.

## Pruebas gratis desde la app

`POST /api/license/prueba` (lo usa el botón "Probar gratis" de la pantalla de licencia). Crea una licencia `prueba`
(14 días, nota "Prueba autoservicio") ya activada en ese celular. Una por celular; tope de 3 por conexión cada 30 días y
300 por día en total (se guarda solo una huella, no la IP). Para cambiar los días o apagarlas: `TRIAL_DAYS=7` / `TRIAL_DAYS=0`
en `/etc/zscore-license.env`. Límite conocido: quien borra los datos de la app consigue un celular "nuevo"; el tope por conexión lo frena.

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
