import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { createRoom, joinRoom, getRoom, guess, resetRoom } = await import("../netlify/functions/room.mjs");

test("create room exposes a hidden word and starts with the host", async () => withStore(async () => {
  const created = await createRoom({ playerName: " Fernando " });

  assert.match(created.room.id, /^[A-Z2-9]{6}$/);
  assert.equal(created.room.players.length, 1);
  assert.deepEqual(Object.keys(created.room.players[0]).sort(), ["hits", "id", "misses", "name"].sort());
  assert.equal(created.room.players[0].id, created.playerId);
  assert.equal(created.room.players[0].name, "Fernando");
  assert.equal(created.room.players[0].hits, 0);
  assert.equal(created.room.players[0].misses, 0);
  assert.equal(created.room.currentPlayerId, created.playerId);
  assert.equal(created.room.currentPlayerName, "Fernando");
  assert.equal(created.room.status, "playing");
  assert.equal(created.room.revision, 0);
  assert.equal(created.room.answer, null);
  assert.equal(created.room.misses, 0);
  assert.equal(created.room.maskedWord.includes("_"), true);
}));

test("join adds one guest, recovers the same name, and enforces the two-player limit", async () => withStore(async () => {
  const created = await createRoom({ playerName: "Fernando" });
  const joined = await joinRoom({ roomId: created.room.id, playerName: "Migue" });

  assert.equal(joined.room.players.length, 2);
  assert.equal(joined.playerId, joined.room.players[1].id);
  assert.equal(joined.room.currentPlayerId, created.playerId);
  assert.equal(joined.room.revision, created.room.revision + 1);

  const recovered = await joinRoom({ roomId: created.room.id, playerName: " mígue " });
  assert.equal(recovered.playerId, joined.playerId);
  assert.equal(recovered.room.players.length, 2);
  assert.equal(recovered.room.revision, joined.room.revision);

  const error = await expectPublicError(
    () => joinRoom({ roomId: created.room.id, playerName: "Claudia" }),
    { status: 409, message: /dos jugadores/ }
  );
  assert.equal(error.room, null);
}));

test("correct guess increments that player's hits and keeps the turn", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "casa" });

  const hit = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "a",
    roomRevision: game.room.revision
  });

  assert.deepEqual(hit.room.guessedLetters, ["a"]);
  assert.equal(hit.room.maskedWord, "_a_a");
  assert.equal(hit.room.currentPlayerId, game.hostId);
  assert.equal(player(hit.room, game.hostId).hits, 1);
  assert.equal(player(hit.room, game.hostId).misses, 0);
  assert.equal(hit.room.lastMove.hit, true);
  assert.equal(hit.room.revision, game.room.revision + 1);
}));

test("wrong guess increments that player's misses and passes the turn", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "casa" });

  const missed = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "x",
    roomRevision: game.room.revision
  });

  assert.deepEqual(missed.room.wrongLetters, ["x"]);
  assert.equal(missed.room.misses, 1);
  assert.equal(missed.room.currentPlayerId, game.guestId);
  assert.equal(player(missed.room, game.hostId).hits, 0);
  assert.equal(player(missed.room, game.hostId).misses, 1);
  assert.equal(missed.room.lastMove.hit, false);
  assert.equal(missed.room.revision, game.room.revision + 1);
}));

test("out-of-turn guesses are rejected with the fresh room", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "casa" });

  const error = await expectPublicError(
    () => guess({
      roomId: game.room.id,
      playerId: game.guestId,
      letter: "a",
      roomRevision: game.room.revision
    }),
    { status: 409, message: /Ahora no es tu turno/, room: true }
  );

  assert.equal(error.room.currentPlayerId, game.hostId);
  assert.equal(error.room.revision, game.room.revision);
  assert.deepEqual(error.room.guessedLetters, []);
}));

test("invalid players cannot guess or reset", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "casa" });

  const guessError = await expectPublicError(
    () => guess({
      roomId: game.room.id,
      playerId: "missing-player",
      letter: "a",
      roomRevision: game.room.revision
    }),
    { status: 403, message: /No reconozco/ }
  );
  assert.equal(guessError.room, null);

  const resetError = await expectPublicError(
    () => resetRoom({
      roomId: game.room.id,
      playerId: "missing-player",
      roomRevision: game.room.revision
    }),
    { status: 403, message: /No reconozco/ }
  );
  assert.equal(resetError.room, null);
}));

test("two misses by different players do not reset or change the word", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "casa" });
  const before = await readStoredRoom(store, game.room.id);

  const firstMiss = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "x",
    roomRevision: game.room.revision
  });
  const secondMiss = await guess({
    roomId: game.room.id,
    playerId: game.guestId,
    letter: "y",
    roomRevision: firstMiss.room.revision
  });
  const after = await readStoredRoom(store, game.room.id);

  assert.equal(before.word, "casa");
  assert.equal(after.word, "casa");
  assert.equal(secondMiss.room.maskedWord, "____");
  assert.deepEqual(secondMiss.room.wrongLetters, ["x", "y"]);
  assert.equal(secondMiss.room.currentPlayerId, game.hostId);
}));

test("duplicate correct guesses are rejected without duplicate scoring", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "casa" });

  const hit = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "a",
    roomRevision: game.room.revision
  });
  const error = await expectPublicError(
    () => guess({
      roomId: game.room.id,
      playerId: game.hostId,
      letter: "a",
      roomRevision: hit.room.revision
    }),
    { status: 409, message: /ya estaba jugada/, room: true }
  );
  const stored = await readStoredRoom(store, game.room.id);

  assert.equal(error.room.revision, hit.room.revision);
  assert.equal(player(error.room, game.hostId).hits, 1);
  assert.deepEqual(error.room.guessedLetters, ["a"]);
  assert.equal(stored.word, "casa");
}));

test("duplicate wrong guesses are rejected without extra misses or turn changes", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "casa" });

  const missed = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "x",
    roomRevision: game.room.revision
  });
  const error = await expectPublicError(
    () => guess({
      roomId: game.room.id,
      playerId: game.guestId,
      letter: "x",
      roomRevision: missed.room.revision
    }),
    { status: 409, message: /ya estaba jugada/, room: true }
  );
  const stored = await readStoredRoom(store, game.room.id);

  assert.equal(error.room.revision, missed.room.revision);
  assert.equal(error.room.currentPlayerId, game.guestId);
  assert.equal(player(error.room, game.hostId).misses, 1);
  assert.equal(player(error.room, game.guestId).misses, 0);
  assert.deepEqual(error.room.wrongLetters, ["x"]);
  assert.equal(stored.word, "casa");
}));

test("reset while playing is rejected", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "casa" });

  const error = await expectPublicError(
    () => resetRoom({
      roomId: game.room.id,
      playerId: game.hostId,
      roomRevision: game.room.revision
    }),
    { status: 409, message: /no se puede cambiar/, room: true }
  );

  assert.equal(error.room.status, "playing");
  assert.equal(error.room.revision, game.room.revision);
  assert.equal((await readStoredRoom(store, game.room.id)).word, "casa");
}));

test("stale roomRevision is rejected and returns the fresh room", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "casa" });

  const missed = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "x",
    roomRevision: game.room.revision
  });
  const error = await expectPublicError(
    () => guess({
      roomId: game.room.id,
      playerId: game.guestId,
      letter: "y",
      roomRevision: game.room.revision
    }),
    { status: 409, message: /partida ha cambiado/, room: true }
  );

  assert.equal(error.room.revision, missed.room.revision);
  assert.deepEqual(error.room.wrongLetters, ["x"]);
  assert.equal(player(error.room, game.guestId).misses, 0);
  assert.equal((await readStoredRoom(store, game.room.id)).word, "casa");
}));

test("stale reset roomRevision is rejected and returns the finished room", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "ab" });

  const firstHit = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "a",
    roomRevision: game.room.revision
  });
  const won = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "b",
    roomRevision: firstHit.room.revision
  });
  const error = await expectPublicError(
    () => resetRoom({
      roomId: game.room.id,
      playerId: game.guestId,
      roomRevision: firstHit.room.revision
    }),
    { status: 409, message: /partida ha cambiado/, room: true }
  );

  assert.equal(error.room.revision, won.room.revision);
  assert.equal(error.room.status, "won");
  assert.equal(error.room.answer, "ab");
  assert.equal(error.room.result.type, "winner");
  assert.equal((await readStoredRoom(store, game.room.id)).word, "ab");
}));

test("missing roomRevision is rejected as an out-of-date mutation", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "casa" });

  const error = await expectPublicError(
    () => guess({
      roomId: game.room.id,
      playerId: game.hostId,
      letter: "a"
    }),
    { status: 409, message: /partida ha cambiado/, room: true }
  );

  assert.equal(error.room.revision, game.room.revision);
  assert.deepEqual(error.room.guessedLetters, []);
}));

test("missing or invalid reset roomRevision is rejected before creating a new word", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "ab" });

  const firstHit = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "a",
    roomRevision: game.room.revision
  });
  const won = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "b",
    roomRevision: firstHit.room.revision
  });

  for (const roomRevision of [undefined, "not-a-revision"]) {
    const error = await expectPublicError(
      () => resetRoom({
        roomId: game.room.id,
        playerId: game.guestId,
        roomRevision
      }),
      { status: 409, message: /partida ha cambiado/, room: true }
    );

    assert.equal(error.room.revision, won.room.revision);
    assert.equal(error.room.status, "won");
    assert.equal(error.room.answer, "ab");
    assert.equal((await readStoredRoom(store, game.room.id)).word, "ab");
  }
}));

test("accent-insensitive guesses reveal accents and ñ guesses work", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "cañón" });

  const accentHit = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "o",
    roomRevision: game.room.revision
  });
  const enyeHit = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "ñ",
    roomRevision: accentHit.room.revision
  });

  assert.equal(accentHit.room.maskedWord, "___ó_");
  assert.equal(enyeHit.room.maskedWord, "__ñó_");
  assert.equal(player(enyeHit.room, game.hostId).hits, 2);
}));

test("winner is decided by higher hits when the word is completed", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "ab" });

  const firstHit = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "a",
    roomRevision: game.room.revision
  });
  const won = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "b",
    roomRevision: firstHit.room.revision
  });

  assert.equal(won.room.status, "won");
  assert.equal(won.room.answer, "ab");
  assert.equal(won.room.result.type, "winner");
  assert.equal(won.room.result.playerId, game.hostId);
  assert.equal(won.room.result.playerName, "Fernando");
  assert.equal(won.room.result.hits, 2);
}));

test("tie result is returned when players finish with equal hits", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "abmn" });
  let room = game.room;

  room = (await guess({ roomId: game.room.id, playerId: game.hostId, letter: "a", roomRevision: room.revision })).room;
  room = (await guess({ roomId: game.room.id, playerId: game.hostId, letter: "c", roomRevision: room.revision })).room;
  room = (await guess({ roomId: game.room.id, playerId: game.guestId, letter: "b", roomRevision: room.revision })).room;
  room = (await guess({ roomId: game.room.id, playerId: game.guestId, letter: "d", roomRevision: room.revision })).room;
  room = (await guess({ roomId: game.room.id, playerId: game.hostId, letter: "e", roomRevision: room.revision })).room;
  room = (await guess({ roomId: game.room.id, playerId: game.guestId, letter: "f", roomRevision: room.revision })).room;
  room = (await guess({ roomId: game.room.id, playerId: game.hostId, letter: "g", roomRevision: room.revision })).room;
  room = (await guess({ roomId: game.room.id, playerId: game.guestId, letter: "h", roomRevision: room.revision })).room;

  assert.equal(room.status, "lost");
  assert.equal(room.result.type, "tie");
  assert.equal(room.result.hits, 1);
  assert.equal(room.result.players.length, 2);
  assert.equal(player(room, game.hostId).hits, 1);
  assert.equal(player(room, game.guestId).hits, 1);
}));

test("reset after terminal status starts a new word and clears scores", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "ab" });

  const firstHit = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "a",
    roomRevision: game.room.revision
  });
  const won = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "b",
    roomRevision: firstHit.room.revision
  });
  const reset = await resetRoom({
    roomId: game.room.id,
    playerId: game.guestId,
    roomRevision: won.room.revision
  });
  const stored = await readStoredRoom(store, game.room.id);

  assert.equal(reset.room.status, "playing");
  assert.equal(reset.room.answer, null);
  assert.deepEqual(reset.room.guessedLetters, []);
  assert.deepEqual(reset.room.wrongLetters, []);
  assert.equal(reset.room.misses, 0);
  assert.equal(reset.room.currentPlayerId, game.hostId);
  assert.equal(reset.room.currentPlayerName, "Fernando");
  assert.equal(reset.room.revision, won.room.revision + 1);
  assert.equal(reset.room.players.every((item) => item.hits === 0 && item.misses === 0), true);
  assert.notEqual(stored.word, "ab");
}));

test("winner starts the next round after reset", async () => withStore(async ({ store }) => {
  const game = await createJoinedRoom(store, { word: "ab" });

  const hostMiss = await guess({
    roomId: game.room.id,
    playerId: game.hostId,
    letter: "x",
    roomRevision: game.room.revision
  });
  const firstGuestHit = await guess({
    roomId: game.room.id,
    playerId: game.guestId,
    letter: "a",
    roomRevision: hostMiss.room.revision
  });
  const guestWon = await guess({
    roomId: game.room.id,
    playerId: game.guestId,
    letter: "b",
    roomRevision: firstGuestHit.room.revision
  });
  const reset = await resetRoom({
    roomId: game.room.id,
    playerId: game.hostId,
    roomRevision: guestWon.room.revision
  });

  assert.equal(guestWon.room.result.type, "winner");
  assert.equal(guestWon.room.result.playerId, game.guestId);
  assert.equal(reset.room.status, "playing");
  assert.equal(reset.room.currentPlayerId, game.guestId);
  assert.equal(reset.room.currentPlayerName, "Migue");
  assert.equal(reset.room.players.every((item) => item.hits === 0 && item.misses === 0), true);
}));

async function withStore(run) {
  const previousStore = process.env.LOCAL_ROOM_STORE;
  const store = await mkdtemp(join(tmpdir(), "ahorcado-"));
  process.env.LOCAL_ROOM_STORE = store;

  try {
    return await run({ store });
  } finally {
    if (previousStore === undefined) {
      delete process.env.LOCAL_ROOM_STORE;
    } else {
      process.env.LOCAL_ROOM_STORE = previousStore;
    }
    await rm(store, { recursive: true, force: true });
  }
}

async function createJoinedRoom(store, { word }) {
  const created = await createRoom({ playerName: "Fernando" });
  const joined = await joinRoom({ roomId: created.room.id, playerName: "Migue" });

  if (word) {
    await forceRoom(store, created.room.id, (room) => {
      room.word = word;
      room.guessedLetters = [];
      room.wrongLetters = [];
      room.status = "playing";
      room.lastMove = null;
      room.currentPlayerId = created.playerId;
    });
  }

  const fresh = await getRoom({ roomId: created.room.id });
  return {
    room: fresh.room,
    hostId: created.playerId,
    guestId: joined.playerId
  };
}

async function expectPublicError(action, { status, message, room = false }) {
  let thrown = null;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown, "Expected action to reject");
  assert.equal(thrown.status, status);
  if (message) {
    assert.match(thrown.publicMessage || thrown.message, message);
  }
  if (room) {
    assert.ok(thrown.room, "Expected error to include a fresh room");
  }
  return thrown;
}

function player(room, playerId) {
  return room.players.find((item) => item.id === playerId);
}

async function readStoredRoom(store, roomId) {
  return JSON.parse(await readFile(join(store, `${roomId}.json`), "utf8"));
}

async function forceRoom(store, roomId, mutate) {
  const room = await readStoredRoom(store, roomId);
  await mutate(room);
  await writeFile(join(store, `${roomId}.json`), JSON.stringify(room, null, 2));
}
