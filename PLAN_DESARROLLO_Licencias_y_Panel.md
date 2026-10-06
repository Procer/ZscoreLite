# Plan de desarrollo: licencias, panel de administración y cobro (Z-Score Lite)

Fecha: 2026-10-06. Base: análisis de `server/*.cjs`, `www/js/license.js`, `INFORME_Z-Score-Lite.txt`.

## Objetivo

Pasar de "licencias por comandos, sin instalar y sin cobro" a un sistema que se opera desde un panel web, cobra con Mercado Pago y protege el APK. Sin dependencias nuevas en el servidor (Node puro, como hoy).

## Estado de partida

- Construido y probado local: servicio, comandos, validación en la app, descarga protegida.
- No instalado en el VPS. `LICENSE_REQUIRED = false`. El APK sigue público.
- Sin panel, sin cobro, sin historial, sin edición de licencias, sin autoservicio de pruebas.

## Decisiones previas (bloquean fases concretas)

| # | Decisión | Bloquea | Propuesta por defecto |
|---|---|---|---|
| D1 | Precio por dispositivo y moneda | F6 | Definir antes de F6; no frena F1 a F5 |
| D2 | Pago único mensual o suscripción | F6 | Suscripción de Mercado Pago, con renovación manual como respaldo |
| D3 | Política de prueba: días, una por persona/dispositivo | F7 | 14 días, una por dispositivo |
| D4 | Contraseña y acceso del panel | F3 | Usuario único, contraseña larga, solo por HTTPS |
| D5 | ¿Cierre "duro" de la web de la raíz? | F8 | Dejarlo fuera de este plan |

## Fases

### F0. Respaldo y preparación (medio día)

- Copiar `C:\Users\juan.derosas\zscore-keys` a un lugar fuera de la PC. Sin la clave del APK no se puede actualizar a nadie.
- Crear un entorno de prueba local con `DATA_DIR` y claves de prueba distintas de las reales.
- Congelar un commit base (tag) antes de tocar el servidor.

**Listo cuando:** hay un segundo respaldo de las claves y se puede levantar el servicio local con datos de prueba.

### F1. Datos sólidos (1 a 2 días) — HECHA 2026-10-06

Se hace antes del panel porque el panel multiplica las escrituras.

- **Bloqueo de escritura** en `license-lib.cjs`: archivo de lock (`wx`) con reintento corto y detección de lock viejo. Hoy `update()` lee, modifica y escribe el archivo entero; dos procesos a la vez pueden perder un cambio.
- **Campos nuevos** por licencia: `customer`, `contact`, `price`, `currency`, `events[]`.
- **Historial** (`events`): cada acción (crear, extender, revocar, reactivar, resetear, convertir, pago, activación de dispositivo) guarda fecha, actor (`cli`, `panel`, `mp`) y detalle.
- **Migración** de `licenses.json` existente, con copia de seguridad automática previa y versión de esquema.
- **Comandos nuevos** en `license-admin.cjs`: `editar` (nota, cliente, contacto), `convertir` (prueba a paga), `dispositivos` (cambiar el máximo).
- **Tests** con `node --test`: concurrencia (dos procesos escribiendo), migración, reglas de `blockReason`, tokens.

**Listo cuando:** una prueba de estrés con servicio y CLI escribiendo a la vez no pierde ningún cambio, y una base vieja migra sin perder datos.

### F2. Instalar en el VPS, sin prender (medio día, requiere tu confirmación) — HECHA 2026-10-06

Pasos 1 y 2 del informe. Toca systemd, nginx y copia la clave privada.

- Instalar servicio y bloque de nginx para `/api/license` (`zscore-license.service`, `nginx-license.conf`).
- Copiar la clave privada con modo 700/600.
- Probar con `curl` activar, renovar y versión.
- Crear tu licencia de cortesía.
- **No** tocar `LICENSE_REQUIRED` ni borrar el APK público todavía.

**Listo cuando:** el servicio responde desde `lite.zscore.ar` y tu licencia de cortesía activa en una copia de prueba.

### F3. API de administración y panel (3 a 5 días) — HECHA en código el 2026-10-06; falta desplegar

- **Servicio separado del público:** mismo proceso, otro puerto o prefijo (`/api/admin`), con nginx restringido a HTTPS.
- **Autenticación:** sesión con cookie `HttpOnly` y `SameSite=Strict`, contraseña con hash (`crypto.scrypt`), límite de intentos, cierre por inactividad, token anti-CSRF en cada acción.
- **Endpoints:** listar con filtros y orden, ver, crear, extender, convertir, revocar, reactivar, resetear, editar, link de descarga, publicar APK (subida con tope de tamaño), estadísticas.
- **Pantallas** (HTML, CSS y JS sin librerías, mismo estilo visual de Lite):
  1. Resumen: activas, por vencer en 7 días, vencidas, revocadas, pruebas, cortesías.
  2. Tabla de licencias con búsqueda y filtros por estado y tipo.
  3. Detalle: datos del cliente, dispositivos, línea de tiempo de eventos, acciones.
  4. APK y versiones: versión vigente, novedades, publicar y generar links.
  5. Cola de tareas: por vencer, pruebas sin convertir y licencias sin dispositivo.
- **Aviso de demora de corte** al revocar: se corta cuando vence el token del celular (hasta 32 + 3 días). El panel lo explica y muestra cuándo vence.
- **Pruebas:** tests de la API (permisos, CSRF, límites) y recorrido manual en el navegador.

**Listo cuando:** se hace todo el ciclo (crear, activar desde un celular, extender, resetear, revocar, link de descarga) sin abrir una consola, y sin sesión no se puede leer ni escribir nada.

### F4. APK y protección (1 día, requiere tu confirmación)

Pasos 2 y 3 del informe.

- Publicar el APK 1.5 desde el panel, con sus novedades.
- Instalar el APK 1.5 en tu celular (hacer antes la copia de seguridad desde la app).
- **Borrar el APK público** del VPS (`/var/www/zscore/lite/descargar/zscore-lite.apk`) y el enlace en `sitio-lite`. Sin esto la protección no sirve.
- Verificar que la URL vieja da 404.

**Listo cuando:** la única forma de bajar el APK es con link personal y licencia al día.

### F5. Prueba de punta a punta y encendido (1 a 2 días)

Seguir `GUIA_DE_PRUEBAS_Licencias.txt` completa.

- Casos: código inexistente, código ya usado en otro dispositivo, vencida, revocada, gracia, bloqueo, cambio de celular, sin internet en la cancha, hora del celular atrasada.
- Probar en celular real lo que solo se vio en navegador: sonido, vibración, copiar link en vivo, copia de seguridad.
- Pilotear con 2 o 3 clubes amigos con licencias `prueba`.
- Recién ahí cambiar `LICENSE_REQUIRED = true` y publicar la web.

**Listo cuando:** el piloto corre una semana sin bloqueos injustos y sin código ni dispositivo duplicado.

### F6. Cobro con Mercado Pago (3 a 5 días, requiere D1 y D2) — CÓDIGO HECHO 2026-10-06 (pago único por período, con links); falta activar con credenciales y probar en el entorno de pruebas de Mercado Pago

- Cuenta de vendedor y credenciales guardadas **fuera del repo** (variables de entorno del servicio).
- Crear el plan o link de pago por dispositivo.
- **Webhook** `/api/pagos/mp`: verificar la firma del aviso, consultar el pago a la API de Mercado Pago (no confiar en el cuerpo del aviso), ser idempotente por id de pago, y crear o extender la licencia.
- Registrar el pago en `events` y en la ficha del cliente; mostrarlo en el panel con ingresos del mes y por vencer.
- Entrega automática del código por mail o WhatsApp, y del link de descarga.
- Caso de cobro fallido o contracargo: la licencia queda marcada y se decide a mano en el panel.
- Pruebas en el entorno de pruebas de Mercado Pago antes de cobrar dinero real.

**Listo cuando:** un pago de prueba crea la licencia, entrega el código y aparece en el panel sin intervención, y un aviso repetido no la extiende dos veces.

### F7. Pruebas por autoservicio (2 días, requiere D3) — HECHA en código 2026-10-06 (14 días, una por celular); falta desplegar el servicio y la web

- Endpoint que entrega un código `prueba` a un dispositivo que no tuvo una antes (límite por dispositivo y por IP).
- Botón "Probar 14 días" en la app y en `sitio-lite`.
- El panel muestra pruebas por vencer con botón de conversión a paga.

**Listo cuando:** una persona nueva se activa sola y no puede pedir una segunda prueba desde el mismo dispositivo.

### F8. Sitio y comunicación (medio día)

- Corregir `sitio-lite/index.html:7` ("Gratis"): precio, prueba gratuita y forma de pago.
- Actualizar `INFORME_Z-Score-Lite.txt` y `server/README.md` con el panel, el cobro y el procedimiento de respaldo.
- Textos de la app: pantalla de licencia con el link para renovar.

## Orden y tiempos

F0 → F1 → F2 → F3 → F4 → F5 → (F6 y F7 en paralelo) → F8. El sistema ya protegido y operable queda después de F5, unos 8 a 12 días de trabajo. Cobro automático y pruebas por autoservicio suman 5 a 7 días más.

## Riesgos y cómo se cubren

| Riesgo | Mitigación |
|---|---|
| Perder la clave privada | F0: respaldo fuera de la PC |
| Pisar datos con escrituras simultáneas | F1: lock y test de concurrencia |
| Panel expuesto a internet | Sesión, CSRF, límite de intentos, HTTPS, nginx; idealmente restringir por IP o VPN |
| Webhook falso que regala licencias | Verificar firma y consultar el pago a la API de Mercado Pago |
| Bloquear a un cliente que pagó | Gracia de 3 días, renovación silenciosa y botón de extender manual |
| Control "blando" que un técnico puede saltar | Aceptado por ahora (D5); mitigado por el APK protegido |
| Cambios en el APK que obliguen a actualizar a todos | Los cambios web llegan solos; solo lo nativo pide APK nuevo |

## Hallazgo agregado durante F3

(ARREGLADO 2026-10-06: las cortesías ahora reciben un certificado de 32 días y la app migra las viejas al renovar; falta desplegar el servicio y la web.) Revocar una **cortesía** no bloqueaba el celular: su certificado no tiene vencimiento (`exp = null`) y la app nunca lo renueva
(`license.js`: `renew()` sale si `exp == null`). El panel lo avisa al revocar. Arreglo propuesto (entra en F5 o F8):
darle a las cortesías un certificado de 32 días que la app renueve como los demás. Toca `license-lib.cjs` y `license.js`.

## Fuera de alcance

Cierre "duro" de la web, varios dispositivos por licencia en el diseño del token, revocación inmediata y licencias para PRO o Sistema.
