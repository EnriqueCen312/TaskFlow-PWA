# TaskFlow API

## Requisitos

- Node.js 18 o posterior.
- En PowerShell, ejecuta `cd .\backend`, `npm.cmd install` y `npm.cmd start`.
- Por defecto, la API escucha en `http://localhost:3000`; el proceso se enlaza a `0.0.0.0` para admitir despliegues en contenedores.
- En PowerShell, para cambiar el puerto: `$env:PORT=3001; npm.cmd start`.
- Sirve el frontend desde la carpeta raíz con un servidor HTTP estático (por ejemplo, la extensión Live Server de VS Code) y abre su URL en el navegador. No abras `index.html` como archivo local: Service Workers requieren HTTPS o `localhost`.
- Comprueba el backend con `curl.exe http://localhost:3000/api/health`.

## Variables de entorno

- `PORT`: puerto de escucha; usa `3000` si no se define.
- `FRONTEND_URL`: origen permitido del frontend, por ejemplo `https://tasks.example.com`. Se aceptan varios orígenes separados por comas.
- `NODE_ENV=production`: desactiva la excepción CORS para `localhost` y `127.0.0.1`; define `FRONTEND_URL` para permitir el frontend desplegado.
- `FRONTEND_ORIGINS` todavía se acepta como configuración adicional por compatibilidad.

En Windows CMD, configura el origen antes de iniciar el servidor con `set FRONTEND_URL=https://tasks.example.com`. En PowerShell, usa `$env:FRONTEND_URL="https://tasks.example.com"`.

En producción, establece las variables en la configuración del proveedor de hosting. Usa HTTPS en frontend y API. No incluyas credenciales ni secretos en el código del frontend.

### URL del backend del frontend

En `config.js`, establece `PRODUCTION_API_BASE_URL` a la URL pública de la API, terminada en `/api/`, por ejemplo `https://api.example.com/api/`. Si se deja vacía, TaskFlow usa `http://localhost:3000/api/` únicamente cuando se sirve desde `localhost` o `127.0.0.1`; en otros dominios usa `/api/` en el mismo origen. Publica el archivo actualizado junto con el resto del frontend.

El backend persiste en `data/activities.json`, lo cual es adecuado para pruebas locales. En producción, el hosting debe ofrecer almacenamiento persistente para ese archivo o se debe migrar a una base de datos; algunos proveedores eliminan archivos al reiniciar o redeplegar.

## Rutas

- `GET /api/health`: estado del servicio.
- `GET /api/activities`: actividades confirmadas.
- `GET /api/activities?includeDeleted=true`: actividades y marcas de eliminación para reconciliación.
- `POST /api/activities`: crea o confirma idempotentemente una actividad con su ID local.
- `PUT /api/activities/:id`: actualiza o crea una actividad ausente, comparando `updatedAt`.
- `DELETE /api/activities/:id`: recibe `updatedAt` en el cuerpo JSON y registra una marca de eliminación.

Los cambios se escriben en `data/activities.json`. Las marcas de eliminación se conservan para que una versión antigua sincronizada no resucite actividades eliminadas.

## Sincronización

IndexedDB sigue siendo la fuente de lectura y escritura inmediata del cliente. La cola `syncQueue` conserva cambios hasta que el servidor responde con una confirmación válida. Al conectar, la app envía la cola y luego reconcilia el estado remoto según `updatedAt`.

Para probar el flujo offline, crea una actividad con ambos servicios activos, desactiva la conexión desde DevTools y crea o edita actividades. Al volver a habilitar la conexión, el panel debe indicar que se sincronizaron; confirma el estado con `curl.exe http://localhost:3000/api/activities`.
