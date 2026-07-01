import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getStore } from "@netlify/blobs";

const MAX_WRONG = 6;
const ROOM_TTL_MS = 1000 * 60 * 60 * 12;
const STORE_NAME = "ahorcado-rooms";

const WORDS = [
  "aceituna", "acueducto", "albahaca", "alboroto", "almendra", "amanecer", "amistad", "anchoa",
  "andamio", "aplauso", "arandano", "arcilla", "armario", "azulejo", "baldosa", "barandilla",
  "berenjena", "biblioteca", "bizcocho", "brujula", "caballero", "cacerola", "calabaza", "callejon",
  "campanario", "caramelo", "carpintero", "castillo", "cazuela", "cebolla", "cerradura", "chimenea",
  "chirimoya", "cicatriz", "cigarrillo", "colmena", "cometa", "concierto", "corazon", "cuchara",
  "delfin", "destello", "diamante", "domingo", "duende", "embarcadero", "enigma", "escalera",
  "escoba", "esmeralda", "espantapajaros", "espejismo", "estanque", "farolillo", "ferrocarril",
  "flamenco", "girasol", "golondrina", "granada", "guitarra", "habitacion", "hormiga", "jirafa",
  "laberinto", "lagartija", "lampara", "lechuga", "limonada", "luciérnaga", "malagueña", "manzanilla",
  "mariposa", "melocoton", "merienda", "murcielago", "naranjo", "naufrago", "nevera", "nostalgia",
  "orquesta", "paellera", "panadero", "pantalla", "pañuelo", "paraguas", "pasteleria", "patinete",
  "pelicula", "pimiento", "piruleta", "pizarra", "primavera", "quesadilla", "relampago", "relojero",
  "rompecabezas", "sandalia", "sandia", "sarten", "serenata", "sombrilla", "tobogan", "tomillo",
  "tortuga", "tranvia", "ventana", "vergüenza", "zapatero", "zanahoria"
];

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8"
};

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return json({ error: "Metodo no permitido" }, 405);
  }

  try {
    const body = await request.json();
    const action = String(body.action || "");

    if (action === "create") {
      return json(await createRoom(body));
    }

    if (action === "join") {
      return json(await joinRoom(body));
    }

    if (action === "get") {
      return json(await getRoom(body));
    }

    if (action === "guess") {
      return json(await guess(body));
    }

    if (action === "reset") {
      return json(await resetRoom(body));
    }

    return json({ error: "Accion desconocida" }, 400);
  } catch (error) {
    const status = error.status || 500;
    const body = { error: error.publicMessage || "No he podido procesar la jugada" };
    if (error.room) body.room = error.room;
    return json(body, status);
  }
}

export async function createRoom({ playerName }) {
  const now = Date.now();
  const room = {
    id: makeRoomId(),
    createdAt: now,
    updatedAt: now,
    word: pickWord(),
    guessedLetters: [],
    wrongLetters: [],
    maxWrong: MAX_WRONG,
    status: "playing",
    revision: 0,
    players: [makePlayer(playerName, "Anfitrion")]
  };
  room.currentPlayerId = room.players[0].id;

  await saveRoom(room);
  return { room: publicRoom(room), playerId: room.players[0].id };
}

export async function joinRoom({ roomId, playerName }) {
  const room = await loadRoom(roomId);
  pruneExpired(room);
  ensureCurrentPlayer(room);
  ensurePlayerScores(room);
  ensureRoomRevision(room);

  let player = room.players.find((item) => sameName(item.name, playerName));
  if (!player) {
    if (room.players.length >= 2) {
      throw publicError("La sala ya tiene dos jugadores", 409);
    }

    player = makePlayer(playerName, "Invitado");
    room.players.push(player);
    room.updatedAt = Date.now();
    await saveRoomWithRevision(room, room.revision);
  }

  return { room: publicRoom(room), playerId: player.id };
}

export async function getRoom({ roomId }) {
  const room = await loadRoom(roomId);
  pruneExpired(room);
  ensureCurrentPlayer(room);
  ensurePlayerScores(room);
  ensureRoomRevision(room);
  return { room: publicRoom(room) };
}

export async function guess({ roomId, playerId, letter, roomRevision }) {
  const room = await loadRoom(roomId);
  pruneExpired(room);
  ensurePlayerScores(room);
  ensureRoomRevision(room);

  const player = room.players.find((item) => item.id === playerId);
  if (!player) {
    throw publicError("No reconozco a este jugador en la sala", 403);
  }
  ensureCurrentPlayer(room);
  assertFreshRevision(room, roomRevision);

  if (room.status !== "playing") {
    return { room: publicRoom(room) };
  }

  if (room.currentPlayerId !== playerId) {
    throw publicError("Ahora no es tu turno", 409, room);
  }

  const normalizedLetter = normalizeLetter(letter);
  if (!normalizedLetter) {
    throw publicError("Letra no valida", 400);
  }

  const allGuesses = new Set([...room.guessedLetters, ...room.wrongLetters]);
  if (allGuesses.has(normalizedLetter)) {
    throw publicError("La letra ya estaba jugada", 409, room);
  }

  const hit = wordLetters(room.word).has(normalizedLetter);
  if (hit) {
    room.guessedLetters.push(normalizedLetter);
    player.hits += 1;
  } else {
    room.wrongLetters.push(normalizedLetter);
    player.misses += 1;
    room.currentPlayerId = nextPlayerId(room, playerId);
  }

  room.lastMove = { playerId, playerName: player.name, letter: normalizedLetter, hit, at: Date.now() };
  room.updatedAt = Date.now();
  updateStatus(room);
  await saveRoomWithRevision(room, room.revision);

  return { room: publicRoom(room) };
}

export async function resetRoom({ roomId, playerId, roomRevision }) {
  const room = await loadRoom(roomId);
  pruneExpired(room);
  ensurePlayerScores(room);
  ensureRoomRevision(room);

  const player = room.players.find((item) => item.id === playerId);
  if (!player) {
    throw publicError("No reconozco a este jugador en la sala", 403);
  }
  ensureCurrentPlayer(room);
  assertFreshRevision(room, roomRevision);

  if (room.status === "playing") {
    throw publicError("La palabra no se puede cambiar hasta terminar la partida", 409, room);
  }

  room.word = pickWord(room.word);
  room.guessedLetters = [];
  room.wrongLetters = [];
  for (const roomPlayer of room.players) {
    roomPlayer.hits = 0;
    roomPlayer.misses = 0;
  }
  room.status = "playing";
  room.lastMove = null;
  room.currentPlayerId = room.players[0]?.id || player.id;
  room.updatedAt = Date.now();
  await saveRoomWithRevision(room, room.revision);

  return { room: publicRoom(room) };
}

function updateStatus(room) {
  const letters = wordLetters(room.word);
  const guessed = new Set(room.guessedLetters);
  const won = [...letters].every((item) => guessed.has(item));
  const lost = room.wrongLetters.length >= room.maxWrong;
  room.status = won ? "won" : lost ? "lost" : "playing";
}

function publicRoom(room) {
  ensureCurrentPlayer(room);
  ensurePlayerScores(room);
  ensureRoomRevision(room);
  const ended = room.status !== "playing";
  const currentPlayer = room.players.find((player) => player.id === room.currentPlayerId) || room.players[0] || null;
  return {
    id: room.id,
    maskedWord: maskWord(room.word, room.guessedLetters, ended),
    answer: ended ? room.word : null,
    guessedLetters: room.guessedLetters,
    wrongLetters: room.wrongLetters,
    misses: room.wrongLetters.length,
    maxWrong: room.maxWrong,
    status: room.status,
    revision: room.revision,
    players: room.players.map(({ id, name, hits, misses }) => ({ id, name, hits, misses })),
    result: ended ? gameResult(room) : null,
    currentPlayerId: currentPlayer?.id || null,
    currentPlayerName: currentPlayer?.name || null,
    lastMove: room.lastMove || null,
    updatedAt: room.updatedAt
  };
}

function maskWord(word, guessedLetters, reveal) {
  const guessed = new Set(guessedLetters);
  return [...word].map((char) => {
    if (char === "-" || char === " ") return char;
    return reveal || guessed.has(normalizeLetter(char)) ? char : "_";
  }).join("");
}

function wordLetters(word) {
  return new Set([...word].map(normalizeLetter).filter(Boolean));
}

function normalizeLetter(value) {
  const char = String(value || "").trim().toLocaleLowerCase("es").charAt(0);
  if (!char) return "";
  if (char === "ñ") return "ñ";
  const normalized = char.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return /^[a-z]$/.test(normalized) ? normalized : "";
}

function pickWord(previous = "") {
  const pool = WORDS.filter((word) => word !== previous);
  return pool[Math.floor(Math.random() * pool.length)];
}

function ensureCurrentPlayer(room) {
  if (!room.currentPlayerId || !room.players.some((player) => player.id === room.currentPlayerId)) {
    room.currentPlayerId = room.players[0]?.id || null;
  }
}

function ensurePlayerScores(room) {
  for (const player of room.players) {
    player.hits = Number.isFinite(player.hits) ? player.hits : 0;
    player.misses = Number.isFinite(player.misses) ? player.misses : 0;
  }
}

function ensureRoomRevision(room) {
  room.revision = Number.isFinite(room.revision) ? room.revision : 0;
}

function assertFreshRevision(room, roomRevision) {
  const revision = typeof roomRevision === "number"
    ? roomRevision
    : typeof roomRevision === "string" && roomRevision.trim() !== ""
      ? Number(roomRevision)
      : NaN;
  if (!Number.isInteger(revision) || revision !== room.revision) {
    throw publicError("La partida ha cambiado. Actualizo el turno.", 409, room);
  }
}

function gameResult(room) {
  ensurePlayerScores(room);
  if (room.players.length === 0) return null;

  const topHits = Math.max(...room.players.map((player) => player.hits));
  const topPlayers = room.players.filter((player) => player.hits === topHits);
  const publicPlayers = topPlayers.map(({ id, name, hits, misses }) => ({ id, name, hits, misses }));

  if (topPlayers.length === 1) {
    return {
      type: "winner",
      playerId: topPlayers[0].id,
      playerName: topPlayers[0].name,
      hits: topPlayers[0].hits,
      misses: topPlayers[0].misses,
      players: publicPlayers
    };
  }

  return {
    type: "tie",
    hits: topHits,
    players: publicPlayers
  };
}

function nextPlayerId(room, currentPlayerId) {
  if (room.players.length < 2) return currentPlayerId;
  const currentIndex = room.players.findIndex((player) => player.id === currentPlayerId);
  if (currentIndex === -1) return room.players[0].id;
  return room.players[(currentIndex + 1) % room.players.length].id;
}

function makeRoomId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function makePlayer(playerName, fallback) {
  const cleanName = String(playerName || "").trim().slice(0, 24) || fallback;
  return {
    id: crypto.randomUUID(),
    name: cleanName,
    role: fallback,
    hits: 0,
    misses: 0,
    joinedAt: Date.now()
  };
}

function sameName(left, right) {
  return normalizeName(left) === normalizeName(right);
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ");
}

async function loadRoom(roomId) {
  const id = String(roomId || "").trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(id)) {
    throw publicError("Codigo de sala no valido", 400);
  }

  const room = await getStorage().get(id);
  if (!room) {
    throw publicError("No existe esa sala", 404);
  }

  return room;
}

async function saveRoom(room) {
  await getStorage().set(room.id, room);
}

async function saveRoomWithRevision(room, expectedRevision) {
  const latest = await getStorage().get(room.id);
  if (latest) {
    ensureRoomRevision(latest);
    if (latest.revision !== expectedRevision) {
      throw publicError("La partida ha cambiado. Actualizo el turno.", 409, latest);
    }
  }

  room.revision = expectedRevision + 1;
  await saveRoom(room);
}

function pruneExpired(room) {
  if (Date.now() - room.updatedAt > ROOM_TTL_MS) {
    throw publicError("La sala ha caducado. Crea una nueva.", 410);
  }
}

function getStorage() {
  if (process.env.LOCAL_ROOM_STORE) {
    return localFileStore(process.env.LOCAL_ROOM_STORE);
  }

  const store = getStore(STORE_NAME);
  return {
    async get(key) {
      return store.get(key, { type: "json", consistency: "strong" });
    },
    async set(key, value) {
      await store.setJSON(key, value);
    }
  };
}

function localFileStore(directory) {
  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(join(directory, `${key}.json`), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async set(key, value) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${key}.json`), JSON.stringify(value, null, 2));
    }
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}

function publicError(publicMessage, status, room = null) {
  const error = new Error(publicMessage);
  error.publicMessage = publicMessage;
  error.status = status;
  error.room = room ? publicRoom(room) : null;
  return error;
}
