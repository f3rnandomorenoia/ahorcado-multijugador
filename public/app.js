const API_URL = "/api/room";
const LETTERS = "abcdefghijklmnñopqrstuvwxyz".split("");
const ROOM_CODE_RE = /^[A-Z2-9]{6}$/;

const state = {
  room: null,
  playerId: localStorage.getItem("ahorcado.playerId") || "",
  polling: null,
  busy: false,
  copyTimer: null
};

const $ = (selector) => document.querySelector(selector);

const els = {
  lobby: $("#lobby"),
  game: $("#game"),
  playerName: $("#playerName"),
  roomCode: $("#roomCode"),
  linkNotice: $("#linkNotice"),
  lobbyError: $("#lobbyError"),
  gameError: $("#gameError"),
  createRoom: $("#createRoom"),
  joinRoom: $("#joinRoom"),
  roomId: $("#roomId"),
  copyLink: $("#copyLink"),
  newRound: $("#newRound"),
  turnLabel: $("#turnLabel"),
  statusTitle: $("#statusTitle"),
  statusDetail: $("#statusDetail"),
  endBanner: $("#endBanner"),
  endLabel: $("#endLabel"),
  endTitle: $("#endTitle"),
  endMessage: $("#endMessage"),
  word: $("#word"),
  answer: $("#answer"),
  scoreBoard: $("#scoreBoard"),
  misses: $("#misses"),
  maxWrong: $("#maxWrong"),
  lastMove: $("#lastMove"),
  keyboard: $("#keyboard")
};

els.playerName.value = localStorage.getItem("ahorcado.playerName") || "";

for (const letter of LETTERS) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = letter;
  button.dataset.letter = letter;
  button.setAttribute("aria-label", `Letra ${letter}`);
  button.addEventListener("click", () => guess(letter));
  els.keyboard.append(button);
}

els.createRoom.addEventListener("click", createRoom);
els.joinRoom.addEventListener("click", () => joinRoom(els.roomCode.value));
els.copyLink.addEventListener("click", copyLink);
els.newRound.addEventListener("click", resetRoom);

els.playerName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    if (cleanRoomCode(els.roomCode.value)) joinRoom(els.roomCode.value);
    else createRoom();
  }
});

els.roomCode.addEventListener("input", () => {
  els.roomCode.value = cleanRoomCode(els.roomCode.value);
});

els.roomCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    joinRoom(els.roomCode.value);
  }
});

const linkRoom = cleanRoomCode(new URLSearchParams(location.search).get("sala") || "");
if (linkRoom) {
  els.roomCode.value = linkRoom;
  els.linkNotice.textContent = `Sala ${linkRoom}`;
}

async function createRoom() {
  if (state.busy) return;
  clearErrors();

  const name = currentName();
  if (!name) return showLobbyError("Pon tu nombre primero.");

  setBusy(true);
  const data = await api({ action: "create", playerName: name }, els.lobbyError);
  setBusy(false);
  if (!data) return;

  enterGame(data);
  setRoomInUrl(data.room.id);
}

async function joinRoom(code) {
  if (state.busy) return;
  clearErrors();

  const name = currentName();
  const roomId = cleanRoomCode(code);
  if (!name) return showLobbyError("Pon tu nombre primero.");
  if (!ROOM_CODE_RE.test(roomId)) return showLobbyError("El codigo de sala tiene 6 caracteres.");

  setBusy(true);
  const data = await api({ action: "join", roomId, playerName: name }, els.lobbyError);
  setBusy(false);
  if (!data) return;

  enterGame(data);
  setRoomInUrl(data.room.id);
}

async function refreshRoom(silent = true) {
  if (!state.room || state.busy) return;

  const data = await api({ action: "get", roomId: state.room.id }, silent ? null : els.gameError);
  if (data?.room) {
    state.room = data.room;
    render();
  }
}

async function guess(letter) {
  if (!canPlay()) return;

  clearErrors();
  setBusy(true);
  const data = await api({
    action: "guess",
    roomId: state.room.id,
    playerId: state.playerId,
    letter,
    roomRevision: roomRevision()
  }, els.gameError);
  setBusy(false);

  if (data?.room) {
    state.room = data.room;
    render();
  }
}

async function resetRoom() {
  if (!state.room || state.busy || isPlaying(state.room)) return;

  clearErrors();
  setBusy(true);
  const data = await api({
    action: "reset",
    roomId: state.room.id,
    playerId: state.playerId,
    roomRevision: roomRevision()
  }, els.gameError);
  setBusy(false);

  if (data?.room) {
    state.room = data.room;
    render();
  }
}

function enterGame(data) {
  state.room = data.room;
  state.playerId = data.playerId || state.playerId;
  localStorage.setItem("ahorcado.playerId", state.playerId);
  localStorage.setItem("ahorcado.playerName", currentName());

  els.lobby.classList.add("hidden");
  els.game.classList.remove("hidden");
  render();
  startPolling();
}

function render() {
  const room = state.room;
  if (!room) {
    renderBusy();
    return;
  }

  const players = playersWithScores(room);
  const missCount = totalMisses(room);
  const maxWrong = Number(room.maxWrong) || 6;
  const finished = isFinished(room);
  const result = finished ? finalResult(room, players) : null;
  const visibleParts = Math.min(6, Math.max(0, Math.ceil((missCount / maxWrong) * 6)));

  document.body.className = `miss-${visibleParts} status-${room.status || "playing"}`;

  els.roomId.textContent = room.id || "------";
  els.misses.textContent = String(missCount);
  els.maxWrong.textContent = String(maxWrong);
  els.lastMove.textContent = lastMoveText(room.lastMove);
  els.answer.textContent = finished && room.answer ? `Palabra: ${room.answer}` : "";

  renderTurn(room, players, result);
  renderEndBanner(room, result);
  renderWord(room);
  renderScoreboard(room, players, result);
  renderKeyboard(room);
  renderBusy();
}

function renderTurn(room, players, result) {
  if (result) {
    els.turnLabel.textContent = "Resultado";
    els.statusTitle.textContent = result.type === "winner" ? `¡Gana ${result.playerName}!` : "Empate";
    els.statusDetail.textContent = room.answer ? `Respuesta: ${room.answer}` : "";
    return;
  }

  els.turnLabel.textContent = "Turno";

  if (!isKnownPlayer(players)) {
    els.statusTitle.textContent = "No estas en la sala";
    els.statusDetail.textContent = "Vuelve a entrar con tu nombre.";
    return;
  }

  if (isMyTurn()) {
    els.statusTitle.textContent = "Tu turno";
    els.statusDetail.textContent = `${players.length}/2 jugadores`;
    return;
  }

  els.statusTitle.textContent = `Turno de ${room.currentPlayerName || "otro jugador"}`;
  els.statusDetail.textContent = "Te toca esperar";
}

function renderEndBanner(room, result) {
  const show = Boolean(result);
  els.endBanner.classList.toggle("hidden", !show);
  els.endBanner.classList.toggle("tie", result?.type === "tie");
  els.endBanner.classList.toggle("winner", result?.type === "winner");

  if (!show) {
    els.endTitle.textContent = "";
    els.endMessage.textContent = "";
    return;
  }

  els.endLabel.textContent = "Fin de partida";
  els.endTitle.textContent = result.type === "winner" ? `¡Gana ${result.playerName}!` : "Empate";
  els.endMessage.textContent = endMessage(room, result);
}

function renderWord(room) {
  const maskedWord = String(room.maskedWord || "");
  els.word.replaceChildren();
  els.word.setAttribute("aria-label", `Palabra: ${maskedWord}`);

  for (const char of maskedWord) {
    const span = document.createElement("span");
    if (char === " ") {
      span.className = "letter-space";
      span.textContent = " ";
    } else if (char === "-") {
      span.className = "letter-separator";
      span.textContent = "-";
    } else {
      span.className = "letter";
      span.textContent = char === "_" ? "" : char;
    }
    els.word.append(span);
  }
}

function renderScoreboard(room, players, result) {
  els.scoreBoard.replaceChildren();

  if (!players.length) {
    const empty = document.createElement("p");
    empty.className = "score-empty";
    empty.textContent = "Sin jugadores";
    els.scoreBoard.append(empty);
    return;
  }

  const tiedIds = new Set(result?.players?.map((player) => player.id) || []);

  for (const player of players) {
    const row = document.createElement("article");
    row.className = "score-row";
    row.classList.toggle("you", player.id === state.playerId);
    row.classList.toggle("current", player.id === room.currentPlayerId && isPlaying(room));
    row.classList.toggle("winner", result?.type === "winner" && result.playerId === player.id);
    row.classList.toggle("tie", result?.type === "tie" && tiedIds.has(player.id));

    const nameBlock = document.createElement("div");
    nameBlock.className = "score-name";

    const name = document.createElement("strong");
    name.textContent = player.name || "Jugador";
    nameBlock.append(name);

    const badges = document.createElement("div");
    badges.className = "badges";
    if (player.id === state.playerId) badges.append(badge("tu", "tú"));
    if (player.id === room.currentPlayerId && isPlaying(room)) badges.append(badge("turn", "turno"));
    if (result?.type === "winner" && result.playerId === player.id) badges.append(badge("winner", "gana"));
    if (result?.type === "tie" && tiedIds.has(player.id)) badges.append(badge("tie", "empate"));
    nameBlock.append(badges);

    const stats = document.createElement("div");
    stats.className = "score-values";
    stats.append(scoreValue("Aciertos", player.hits), scoreValue("Avisos", player.misses));

    row.append(nameBlock, stats);
    els.scoreBoard.append(row);
  }
}

function renderKeyboard(room) {
  const guessed = new Set(room.guessedLetters || []);
  const wrong = new Set(room.wrongLetters || []);
  const enabled = canPlay();

  els.keyboard.querySelectorAll("button").forEach((button) => {
    const letter = button.dataset.letter;
    const usedCorrect = guessed.has(letter);
    const usedWrong = wrong.has(letter);

    button.disabled = !enabled || usedCorrect || usedWrong;
    button.classList.toggle("correct", usedCorrect);
    button.classList.toggle("wrong", usedWrong);
  });
}

function renderBusy() {
  els.createRoom.disabled = state.busy;
  els.joinRoom.disabled = state.busy;

  if (!state.room) return;

  const playing = isPlaying(state.room);
  els.newRound.classList.toggle("hidden", playing);
  els.newRound.disabled = state.busy || playing || !isKnownPlayer(playersWithScores(state.room));
  els.copyLink.disabled = state.busy;
}

function badge(kind, label) {
  const item = document.createElement("span");
  item.className = `badge ${kind}`;
  item.textContent = label;
  return item;
}

function scoreValue(label, value) {
  const item = document.createElement("span");
  const number = document.createElement("b");
  number.textContent = String(value || 0);
  item.append(number, document.createTextNode(label));
  return item;
}

function lastMoveText(move) {
  if (!move) return "Sin jugadas";

  const player = move.playerName || "Jugador";
  const letter = String(move.letter || "").toLocaleUpperCase("es");
  const result = move.hit ? "acierta" : "falla";
  return `${player}: ${letter} ${result}`;
}

function endMessage(room, result) {
  const answer = room.answer ? `Palabra: ${room.answer}. ` : "";
  if (result.type === "winner") {
    return `${answer}${result.playerName} termina con ${plural(result.hits, "acierto", "aciertos")}.`;
  }
  return `${answer}${plural(result.hits, "acierto", "aciertos")} por jugador.`;
}

function finalResult(room, players) {
  const result = room.result;
  if (result?.type === "winner") {
    return {
      type: "winner",
      playerId: result.playerId,
      playerName: result.playerName || players.find((player) => player.id === result.playerId)?.name || "Jugador",
      hits: Number(result.hits) || 0,
      misses: Number(result.misses) || 0,
      players: result.players || []
    };
  }

  if (result?.type === "tie") {
    return {
      type: "tie",
      hits: Number(result.hits) || 0,
      players: result.players || players
    };
  }

  const topHits = Math.max(0, ...players.map((player) => player.hits));
  const leaders = players.filter((player) => player.hits === topHits);
  if (leaders.length === 1) {
    return {
      type: "winner",
      playerId: leaders[0].id,
      playerName: leaders[0].name,
      hits: leaders[0].hits,
      misses: leaders[0].misses,
      players: leaders
    };
  }

  return { type: "tie", hits: topHits, players: leaders };
}

async function copyLink() {
  if (!state.room) return;

  clearErrors();
  const link = `${location.origin}${location.pathname}?sala=${state.room.id}`;
  try {
    await copyText(link);
    flashCopyText("Copiado");
  } catch (error) {
    els.gameError.textContent = "No he podido copiar el enlace.";
  }
}

function flashCopyText(label) {
  window.clearTimeout(state.copyTimer);
  els.copyLink.textContent = label;
  state.copyTimer = window.setTimeout(() => {
    els.copyLink.textContent = "Copiar enlace";
  }, 1400);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.className = "copy-buffer";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("copy failed");
}

function startPolling() {
  window.clearInterval(state.polling);
  state.polling = window.setInterval(() => refreshRoom(true), 1700);
}

async function api(payload, errorNode) {
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));

    if (data?.room) {
      state.room = data.room;
      if (!els.game.classList.contains("hidden")) render();
    }

    if (!response.ok) {
      throw new Error(data.error || `Error ${response.status}`);
    }

    return data;
  } catch (error) {
    if (errorNode) errorNode.textContent = error.message;
    return null;
  }
}

function setBusy(value) {
  state.busy = value;
  renderBusy();
  if (state.room) renderKeyboard(state.room);
}

function currentName() {
  return els.playerName.value.trim().replace(/\s+/g, " ").slice(0, 24);
}

function cleanRoomCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
}

function roomRevision() {
  const revision = Number(state.room?.revision);
  return Number.isFinite(revision) ? revision : 0;
}

function playersWithScores(room) {
  return Array.isArray(room.players)
    ? room.players.map((player) => ({
        id: player.id,
        name: player.name || "Jugador",
        hits: Number(player.hits) || 0,
        misses: Number(player.misses) || 0
      }))
    : [];
}

function isKnownPlayer(players = playersWithScores(state.room || {})) {
  return players.some((player) => player.id === state.playerId);
}

function isMyTurn() {
  return state.room?.currentPlayerId === state.playerId;
}

function canPlay() {
  return Boolean(state.room && !state.busy && isPlaying(state.room) && isKnownPlayer() && isMyTurn());
}

function isPlaying(room) {
  return (room?.status || "playing") === "playing";
}

function isFinished(room) {
  return room?.status === "won" || room?.status === "lost";
}

function totalMisses(room) {
  const direct = Number(room?.misses);
  if (Number.isFinite(direct)) return direct;
  return Array.isArray(room?.wrongLetters) ? room.wrongLetters.length : 0;
}

function plural(count, singular, pluralText) {
  return `${count} ${count === 1 ? singular : pluralText}`;
}

function setRoomInUrl(roomId) {
  history.replaceState(null, "", `${location.pathname}?sala=${roomId}`);
}

function clearErrors() {
  els.lobbyError.textContent = "";
  els.gameError.textContent = "";
}

function showLobbyError(message) {
  els.lobbyError.textContent = message;
}
