# Especificacion de producto - Ahorcado multijugador

Documento para rehacer el juego desde cero sin arrastrar los cambios rotos del 2026-06-22.

## Objetivo

Crear un ahorcado multijugador sencillo para jugar desde dos moviles o navegadores mediante una sala compartida por enlace.

La experiencia debe ser estable antes que sofisticada: si hay dudas entre una mejora visual y una regla de juego segura, priorizar la regla de juego segura.

## URL y despliegue

- URL publica deseada: `https://ahorcado-multijugador.netlify.app`.
- No debe aparecer `Fernando` en el subdominio.
- La app puede seguir siendo una web estatica con funcion serverless en Netlify.
- El estado de las salas puede guardarse en Netlify Blobs o almacenamiento equivalente.
- El deploy estable restaurado como referencia es `6a385205364eaaab1391c0a0`, publicado originalmente el 2026-06-21.

## Flujo basico

1. El primer jugador escribe su nombre y crea una sala.
2. La app genera un codigo de sala corto de 6 caracteres.
3. El primer jugador puede copiar un enlace con `?sala=CODIGO`.
4. El segundo jugador abre el enlace, escribe su nombre y entra.
5. La partida se juega en la misma sala desde ambos dispositivos.
6. Cada navegador refresca periodicamente el estado de la sala.

## Jugadores

- Maximo 2 jugadores por sala.
- Cada jugador tiene:
  - `id` interno.
  - `name` visible.
  - `hits` o aciertos.
  - `misses` o avisos.
- Si un jugador entra con el mismo nombre en la misma sala, se debe intentar recuperar su jugador existente en vez de crear un tercero.
- El jugador no debe poder jugar si su `playerId` no pertenece a la sala.

## Reglas de turno

- La partida empieza con el jugador anfitrion.
- Solo el jugador cuyo `id` coincide con `currentPlayerId` puede tirar.
- Si acierta una letra:
  - Se revela la letra.
  - Suma 1 acierto a ese jugador.
  - Mantiene el turno.
- Si falla una letra:
  - La letra se anade a fallos.
  - Suma 1 aviso a ese jugador.
  - El turno pasa al otro jugador.
- Si se intenta jugar fuera de turno, el servidor debe rechazar la jugada con un error claro, por ejemplo `409 Ahora no es tu turno`.
- La UI debe desactivar visualmente las letras cuando no es el turno del jugador, pero la validacion real debe vivir en el servidor.

## Marcador

- El marcador debe verse compacto y claro en movil.
- Mostrar siempre, cerca de la zona de juego, los datos de cada jugador:
  - Nombre.
  - Aciertos.
  - Avisos.
  - Indicador discreto de quien eres tu.
  - Indicador claro de quien tiene el turno.
- Evitar tarjetas grandes que empujen demasiado el teclado hacia abajo.
- Propuesta compacta:
  - Una fila por jugador en movil.
  - Nombre a la izquierda.
  - `Aciertos: N` y `Avisos: N` a la derecha o en chips pequenos.
  - El jugador activo puede resaltarse con borde o fondo suave.
- El marcador debe ser legible sin ocupar media pantalla.

## Fin de partida y ganador

La partida puede terminar por:

- Palabra completada.
- Maximo de fallos globales alcanzado.

Al terminar:

- Gana quien tenga mas aciertos.
- Si los dos tienen los mismos aciertos, mostrar `Empate`.
- El ganador se decide por aciertos, no por quien complete la ultima letra.
- Mostrar la palabra completa al final.
- Mostrar un cartel llamativo:
  - Victoria / ganador: `¡Gana NOMBRE!`.
  - Empate: `Empate`.
  - Si se conserva una vista individual, puede distinguirse victoria/derrota desde el punto de vista del jugador actual, pero el mensaje principal debe declarar el ganador por aciertos.

## Nueva palabra / reinicio

Regla importante tras los fallos del 2026-06-22:

- No debe poder cambiarse la palabra en mitad de una partida.
- `Nueva palabra` solo debe estar disponible cuando la partida haya terminado.
- El servidor debe rechazar cualquier reinicio mientras `status === "playing"`.
- La UI puede ocultar o desactivar el boton durante la partida, pero la proteccion obligatoria debe estar en el servidor.

## Concurrencia y estado desfasado

Para evitar que dos moviles pisen turnos:

- Cada sala debe tener una version o revision interna del estado.
- Cada jugada debe enviar la revision que el cliente cree estar jugando.
- El servidor debe comparar esa revision con la actual.
- Si no coincide:
  - Rechazar la accion.
  - Devolver la sala actualizada.
  - No cambiar turno, palabra, aciertos ni avisos.
- El cliente, al recibir una sala actualizada en un error, debe renderizarla inmediatamente.

Esto debe implementarse con cuidado y cubrirse con tests, porque los cambios anteriores rompieron el flujo.

## Palabras

- Palabras en espanol.
- Incluir `ñ` y soportar acentos de forma razonable:
  - La palabra puede tener acentos.
  - El teclado puede usar letras normalizadas.
  - Si se pulsa `a`, debe cubrir `a` y letras acentuadas equivalentes cuando aplique.
- No cambiar la palabra salvo al crear una sala o iniciar una nueva partida tras terminar.

## Interfaz

- Primera pantalla: crear o entrar a sala.
- Pantalla de juego:
  - Codigo de sala.
  - Boton copiar enlace.
  - Estado de turno.
  - Dibujo del ahorcado.
  - Palabra enmascarada.
  - Marcador compacto por jugador.
  - Ultima jugada.
  - Teclado de letras.
  - Mensaje de error visible cuando una accion se rechaza.
- Debe funcionar bien en movil.
- Evitar que textos largos rompan botones o tarjetas.
- El teclado debe quedar accesible sin demasiado scroll.

## Contratos de API recomendados

Acciones minimas:

- `create`
  - Input: `playerName`.
  - Output: `{ room, playerId }`.
- `join`
  - Input: `roomId`, `playerName`.
  - Output: `{ room, playerId }`.
- `get`
  - Input: `roomId`.
  - Output: `{ room }`.
- `guess`
  - Input: `roomId`, `playerId`, `letter`, `roomRevision`.
  - Output: `{ room }`.
- `reset`
  - Input: `roomId`, `playerId`, `roomRevision`.
  - Permitido solo si la partida ha terminado.
  - Output: `{ room }`.

Campos publicos de `room`:

- `id`
- `maskedWord`
- `answer` solo si termino
- `guessedLetters`
- `wrongLetters`
- `misses`
- `maxWrong`
- `status`: `playing`, `won`, `lost`
- `revision`
- `players`: `{ id, name, hits, misses }`
- `currentPlayerId`
- `currentPlayerName`
- `lastMove`
- `result` si termino
- `updatedAt`

## Tests obligatorios

Antes de desplegar, cubrir como minimo:

- Crear sala.
- Unirse como segundo jugador.
- El anfitrion empieza.
- Acierto suma acierto y conserva turno.
- Fallo suma aviso y cambia turno.
- Jugador fuera de turno recibe `409`.
- Dos fallos seguidos de jugadores distintos no reinician palabra.
- Pulsar varias veces la misma letra no duplica puntos ni cambia palabra.
- Reset durante partida devuelve `409`.
- Reset tras terminar crea nueva palabra y limpia aciertos/avisos.
- Jugada con revision vieja devuelve `409` y sala fresca.
- Ganador final por mayor numero de aciertos.
- Empate si hay igualdad de aciertos.

## Smoke test de produccion

Despues de cada deploy:

1. Abrir la URL publica y comprobar HTTP `200`.
2. Crear sala por API o navegador.
3. Unir segundo jugador.
4. Hacer fallar al jugador 1 y confirmar turno jugador 2.
5. Intentar jugar de nuevo con jugador 1 y confirmar `409`.
6. Hacer fallar al jugador 2 y confirmar:
   - La palabra no cambia.
   - Hay 2 fallos acumulados.
   - Vuelve el turno al jugador 1.
7. Simular aciertos y confirmar marcador por jugador.
8. Terminar partida y confirmar ganador por aciertos.
9. Confirmar que `Nueva palabra` solo funciona tras terminar.

## Riesgos conocidos

- No redeplegar directamente el arbol local actual si conserva cambios experimentales del 2026-06-22.
- Reconstruir desde una base limpia o desde el deploy estable `6a385205364eaaab1391c0a0`.
- No confiar solo en botones desactivados del frontend: todo lo importante debe validarse en servidor.
- Evitar mezclar varias mejoras grandes a la vez. Orden recomendado:
  1. Rehacer base estable de turnos.
  2. Anadir marcador compacto.
  3. Anadir ganador por aciertos.
  4. Anadir cartel final.
  5. Anadir revision/concurrencia.
  6. Probar y desplegar.

