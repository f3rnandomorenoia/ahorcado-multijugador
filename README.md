# Ahorcado multijugador

Webapp para jugar al ahorcado en una sala compartida por enlace, con palabras en espanol y estado guardado en Netlify Blobs.

Produccion: https://ahorcado-multijugador.netlify.app

Repositorio: https://github.com/f3rnandomorenoia/ahorcado-multijugador

Reglas multijugador: el jugador que acierta conserva el turno; cuando falla, el turno pasa al otro jugador.

## Desarrollo local

```bash
npm install
LOCAL_ROOM_STORE=.rooms npm run dev
```

La app queda en `http://localhost:8888` o en el puerto que indique la CLI.

## Verificacion

```bash
npm test
```

## Despliegue en Netlify

```bash
npx netlify-cli@latest login
npm run deploy
```

El login abre un enlace de autorizacion de Netlify. Despues del deploy, crea una sala desde la web publicada y comparte el enlace `?sala=CODIGO` con el segundo jugador.
