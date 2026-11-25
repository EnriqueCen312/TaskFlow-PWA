# TaskFlow

TaskFlow es una PWA de actividades personales. El frontend usa JavaScript nativo, IndexedDB, Service Workers y Notifications API. El backend es una API REST con Express para sincronizar cambios pendientes.

## Requisitos

- Node.js 18 o posterior.
- Un navegador actual.
- Para desarrollo, Visual Studio Code con Live Server (o cualquier servidor estático local compatible con Service Workers).

## Ejecutar en desarrollo

1. Abre la carpeta raíz del proyecto en VS Code y sirve `index.html` con Live Server. No abras el archivo con `file://`.
2. En una terminal, inicia la API:

   ```powershell
   cd .\backend
   npm.cmd install
   npm.cmd start
   ```

3. La API local estará disponible en `http://localhost:3000`. Verifica su estado:

   ```powershell
   curl.exe http://localhost:3000/api/health
   ```

En localhost, `config.js` selecciona automáticamente `http://localhost:3000/api/`. Las actividades se guardan primero en IndexedDB; las operaciones pendientes se envían a la API cuando hay conexión.

## Configuración para producción

### Frontend

Antes de publicar en un dominio distinto de localhost, configura `PRODUCTION_API_BASE_URL` en `config.js` con la URL pública de la API, incluida la ruta `/api/`:

```js
const PRODUCTION_API_BASE_URL = "https://api.example.com/api/";
```

Si frontend y API se sirven bajo el mismo origen, deja el valor vacío; TaskFlow utilizará `/api/`. La URL debe ser HTTPS cuando el frontend use HTTPS. No pongas contraseñas, tokens ni claves en este archivo.

Al publicar una versión con cambios, incrementa `CACHE_NAME` en `sw.js` para que los clientes actualicen la caché del shell. El Service Worker no almacena respuestas de `/api/`.

### Backend

Despliega la carpeta `backend/` en un servicio que ejecute Node.js 18 o posterior. El comando de instalación es `npm install` y el comando de inicio es `npm start` (en PowerShell de Windows también puedes usar `npm.cmd`). El servidor usa `process.env.PORT` (o 3000 si no está definida) y escucha en `0.0.0.0`.

Configura estas variables en el panel de entorno del proveedor:

- `NODE_ENV=production`: deshabilita la excepción CORS para localhost.
- `FRONTEND_URL=https://taskflow.example.com`: origen exacto del frontend, sin ruta final. Para varios orígenes, sepáralos por comas.
- `PORT`: normalmente el proveedor lo asigna automáticamente.

En desarrollo no hace falta definir `FRONTEND_URL`; se permiten orígenes `http://localhost:<puerto>` y `http://127.0.0.1:<puerto>`. `FRONTEND_ORIGINS` se conserva como variable adicional compatible.

## Despliegue

1. Configura la URL de la API en `config.js` y publica el frontend en un hosting estático que sirva HTTPS.
2. Despliega `backend/` en un hosting Node.js y configura `NODE_ENV`, `FRONTEND_URL` y el puerto proporcionado por el hosting.
3. Comprueba `https://<dominio-api>/api/health`.
4. Abre el frontend desplegado, crea una actividad y comprueba su sincronización con `GET https://<dominio-api>/api/activities`.

GitHub Pages puede alojar el frontend estático, pero no ejecuta `server.js`; el backend requiere un hosting Node.js aparte.

## Persistencia del backend

La API actual guarda actividades en `backend/data/activities.json`. Antes de producción real, confirma que el hosting tenga almacenamiento persistente para ese archivo y que no ejecute varias instancias escribiendo al mismo tiempo. Muchos hostings efímeros pierden archivos al reiniciar o redeplegar; en ese caso se requiere un volumen persistente o una base de datos. IndexedDB mantiene la copia local del usuario, pero no sustituye la persistencia central del backend.

El archivo de datos runtime está excluido en `.gitignore` porque puede contener información personal; no se publica como parte del código fuente.
