const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const hostBtn = document.getElementById("hostBtn");
const joinBtn = document.getElementById("joinBtn");
const createResponseBtn = document.getElementById("createResponseBtn");
const applyResponseBtn = document.getElementById("applyResponseBtn");
const lobbyCodeField = document.getElementById("lobbyCode");
const responseCodeField = document.getElementById("responseCode");
const connectionStatus = document.getElementById("connectionStatus");
const connectionHint = document.getElementById("connectionHint");
const goldDisplay = document.getElementById("goldDisplay");
const planeDisplay = document.getElementById("planeDisplay");
const healthDisplay = document.getElementById("healthDisplay");
const damageDisplay = document.getElementById("damageDisplay");
const upgradeBtn = document.getElementById("upgradeBtn");

const PLANE_LEVELS = [
  { name: "Scout", speed: 2.8, armor: 100, damage: 18, cost: 0, cooldown: 160 },
  { name: "Striker", speed: 3.2, armor: 125, damage: 24, cost: 100, cooldown: 145 },
  { name: "Falcon", speed: 3.6, armor: 150, damage: 30, cost: 180, cooldown: 130 },
  { name: "Warden", speed: 4.1, armor: 180, damage: 38, cost: 260, cooldown: 120 },
];

const STAR_COUNT = 70;
const stars = Array.from({ length: STAR_COUNT }, () => ({
  x: Math.random() * canvas.width,
  y: Math.random() * canvas.height,
  speed: 0.4 + Math.random() * 0.8,
  size: 1 + Math.random() * 2,
}));

const keyState = new Set();
let lastTime = 0;

const playerId = crypto.randomUUID();
const players = new Map();
const missiles = [];
const pendingRespawns = new Map();

let peerConnection = null;
let dataChannel = null;
let connectionReady = false;
let isHost = false;
let multiplayerAvailable = true;

const localPlayer = createPlayer({ id: playerId, isLocal: true });
players.set(playerId, localPlayer);

const remotePlayer = createPlayer({ id: "remote", isLocal: false });
players.set(remotePlayer.id, remotePlayer);

function createPlayer({ id, isLocal }) {
  const level = 0;
  const spawnPoint = isLocal
    ? { x: 220 + Math.random() * 120, y: canvas.height / 2 }
    : { x: canvas.width - 220 - Math.random() * 120, y: canvas.height / 2 };
  return {
    id,
    isLocal,
    x: spawnPoint.x,
    y: spawnPoint.y,
    vx: 0,
    vy: 0,
    angle: isLocal ? 0 : Math.PI,
    health: PLANE_LEVELS[level].armor,
    maxHealth: PLANE_LEVELS[level].armor,
    level,
    gold: 0,
    cooldown: 0,
    connected: false,
  };
}

function updateUi() {
  goldDisplay.textContent = `Gold: ${localPlayer.gold}`;
  const level = PLANE_LEVELS[localPlayer.level];
  planeDisplay.textContent = `Plane: ${level.name}`;
  healthDisplay.textContent = `Health: ${Math.max(localPlayer.health, 0)}`;
  if (damageDisplay) {
    damageDisplay.textContent = `Missile Damage: ${level.damage}`;
  }
  const nextLevel = PLANE_LEVELS[localPlayer.level + 1];
  if (nextLevel) {
    upgradeBtn.textContent = `Upgrade Plane (Cost: ${nextLevel.cost})`;
    upgradeBtn.disabled = localPlayer.gold < nextLevel.cost;
  } else {
    upgradeBtn.textContent = "Plane Maxed";
    upgradeBtn.disabled = true;
  }
}

function setStatus(text, connected) {
  connectionStatus.textContent = text;
  connectionStatus.style.background = connected ? "#1c5b36" : "#1e2749";
}

function setHint(text) {
  if (connectionHint) {
    connectionHint.textContent = text;
  }
}

function setMultiplayerAvailability(enabled, message) {
  multiplayerAvailable = enabled;
  hostBtn.disabled = !enabled;
  joinBtn.disabled = !enabled;
  createResponseBtn.disabled = !enabled;
  applyResponseBtn.disabled = !enabled;
  if (message) {
    setStatus(message, false);
    setHint(
      enabled
        ? "Share codes over chat to connect across devices."
        : "Multiplayer needs a secure context and WebRTC support.",
    );
  }
}

function encodeSignal(data) {
  return btoa(JSON.stringify(data));
}

function decodeSignal(value) {
  return JSON.parse(atob(value));
}

function setupConnection() {
  if (!multiplayerAvailable) {
    return;
  }
  peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  peerConnection.oniceconnectionstatechange = () => {
    const state = peerConnection.iceConnectionState;
    if (state === "connected" || state === "completed") {
      connectionReady = true;
      remotePlayer.connected = true;
      setStatus("Connected", true);
    } else if (state === "failed") {
      connectionReady = false;
      remotePlayer.connected = false;
      setStatus("Connection failed", false);
    } else if (state === "disconnected") {
      connectionReady = false;
      remotePlayer.connected = false;
      setStatus("Disconnected", false);
    }
  };

  peerConnection.ondatachannel = (event) => {
    dataChannel = event.channel;
    bindDataChannel();
  };
}

function bindDataChannel() {
  dataChannel.onopen = () => {
    connectionReady = true;
    remotePlayer.connected = true;
    setStatus("Connected", true);
  };
  dataChannel.onclose = () => {
    connectionReady = false;
    remotePlayer.connected = false;
    setStatus("Disconnected", false);
  };
  dataChannel.onmessage = (event) => {
    const message = JSON.parse(event.data);
    handleIncoming(message);
  };
}

async function hostLobby() {
  isHost = true;
  setupConnection();
  if (!peerConnection) {
    return;
  }
  dataChannel = peerConnection.createDataChannel("game");
  bindDataChannel();
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  await waitForIceGathering();
  lobbyCodeField.value = encodeSignal({
    type: "offer",
    sdp: peerConnection.localDescription,
  });
  setStatus("Waiting for response...", false);
}

async function joinLobby() {
  isHost = false;
  setupConnection();
  if (!peerConnection) {
    return;
  }
  const offer = decodeSignal(lobbyCodeField.value.trim());
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer.sdp));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  await waitForIceGathering();
  responseCodeField.value = encodeSignal({
    type: "answer",
    sdp: peerConnection.localDescription,
  });
  setStatus("Share response with host", false);
}

async function applyResponse() {
  if (!peerConnection) {
    return;
  }
  const answer = decodeSignal(responseCodeField.value.trim());
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer.sdp));
  setStatus("Connecting...", false);
}

function waitForIceGathering() {
  return new Promise((resolve) => {
    if (peerConnection.iceGatheringState === "complete") {
      resolve();
      return;
    }
    const check = () => {
      if (peerConnection.iceGatheringState === "complete") {
        peerConnection.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    peerConnection.addEventListener("icegatheringstatechange", check);
  });
}

function handleIncoming(message) {
  if (message.type === "state") {
    const payload = message.payload;
    remotePlayer.x = payload.x;
    remotePlayer.y = payload.y;
    remotePlayer.vx = payload.vx;
    remotePlayer.vy = payload.vy;
    remotePlayer.angle = payload.angle;
    remotePlayer.health = payload.health;
    remotePlayer.maxHealth = payload.maxHealth;
    remotePlayer.level = payload.level;
    remotePlayer.gold = payload.gold;
    remotePlayer.connected = true;
  }
  if (message.type === "missile") {
    missiles.push({
      id: message.id,
      owner: remotePlayer.id,
      x: message.x,
      y: message.y,
      vx: message.vx,
      vy: message.vy,
      damage: message.damage,
      life: 0,
    });
  }
  if (message.type === "damage") {
    localPlayer.health = Math.max(0, localPlayer.health - message.amount);
    if (localPlayer.health === 0) {
      scheduleRespawn(localPlayer, message.by);
    }
  }
  if (message.type === "destroyed") {
    if (message.by === playerId) {
      localPlayer.gold += message.reward;
      updateUi();
    }
  }
}

function sendMessage(data) {
  if (dataChannel && dataChannel.readyState === "open") {
    dataChannel.send(JSON.stringify(data));
  }
}

function sendState() {
  sendMessage({
    type: "state",
    payload: {
      x: localPlayer.x,
      y: localPlayer.y,
      vx: localPlayer.vx,
      vy: localPlayer.vy,
      angle: localPlayer.angle,
      health: localPlayer.health,
      maxHealth: localPlayer.maxHealth,
      level: localPlayer.level,
      gold: localPlayer.gold,
    },
  });
}

function fireMissile(player) {
  const level = PLANE_LEVELS[player.level];
  if (player.cooldown > 0 || player.health <= 0) {
    return;
  }
  const speed = 6.5 + player.level * 0.8;
  const missile = {
    id: crypto.randomUUID(),
    owner: player.id,
    x: player.x + Math.cos(player.angle) * 26,
    y: player.y + Math.sin(player.angle) * 26,
    vx: Math.cos(player.angle) * speed,
    vy: Math.sin(player.angle) * speed,
    damage: level.damage,
    life: 0,
  };
  missiles.push(missile);
  player.cooldown = level.cooldown;
  if (player.isLocal) {
    sendMessage({
      type: "missile",
      id: missile.id,
      x: missile.x,
      y: missile.y,
      vx: missile.vx,
      vy: missile.vy,
      damage: missile.damage,
    });
  }
}

function scheduleRespawn(player, killerId) {
  if (pendingRespawns.has(player.id)) {
    return;
  }
  pendingRespawns.set(player.id, 180);
  if (player.isLocal && killerId && killerId !== player.id) {
    sendMessage({ type: "destroyed", by: killerId, reward: 80 });
  }
}

function respawnPlayer(player) {
  const spawnX = player.isLocal ? 160 : canvas.width - 160;
  player.x = spawnX;
  player.y = canvas.height / 2 + (Math.random() * 80 - 40);
  player.vx = 0;
  player.vy = 0;
  player.health = player.maxHealth;
  player.angle = player.isLocal ? 0 : Math.PI;
}

function updatePlayer(player) {
  if (!player.isLocal) {
    return;
  }
  const level = PLANE_LEVELS[player.level];
  const acceleration = level.speed;
  if (keyState.has("KeyW")) {
    player.vy -= acceleration * 0.18;
  }
  if (keyState.has("KeyS")) {
    player.vy += acceleration * 0.18;
  }
  if (keyState.has("KeyA")) {
    player.vx -= acceleration * 0.18;
  }
  if (keyState.has("KeyD")) {
    player.vx += acceleration * 0.18;
  }
  if (keyState.has("Space")) {
    fireMissile(player);
  }

  player.vx *= 0.96;
  player.vy *= 0.96;
  player.x += player.vx;
  player.y += player.vy;

  const maxSpeed = level.speed * 3.2;
  player.vx = Math.max(Math.min(player.vx, maxSpeed), -maxSpeed);
  player.vy = Math.max(Math.min(player.vy, maxSpeed), -maxSpeed);

  player.x = Math.max(40, Math.min(canvas.width - 40, player.x));
  player.y = Math.max(40, Math.min(canvas.height - 40, player.y));

  player.angle = Math.atan2(player.vy, player.vx || 0.01);

  if (player.cooldown > 0) {
    player.cooldown -= 1;
  }
}

function updateMissiles() {
  for (let i = missiles.length - 1; i >= 0; i -= 1) {
    const missile = missiles[i];
    missile.x += missile.vx;
    missile.y += missile.vy;
    missile.life += 1;

    if (
      missile.x < -50 ||
      missile.x > canvas.width + 50 ||
      missile.y < -50 ||
      missile.y > canvas.height + 50 ||
      missile.life > 320
    ) {
      missiles.splice(i, 1);
      continue;
    }

    const target = missile.owner === localPlayer.id ? remotePlayer : localPlayer;
    if (target.health <= 0) {
      continue;
    }
    const dx = missile.x - target.x;
    const dy = missile.y - target.y;
    if (Math.hypot(dx, dy) < 22) {
      missiles.splice(i, 1);
      if (target.isLocal) {
        target.health = Math.max(0, target.health - missile.damage);
        sendMessage({ type: "damage", amount: missile.damage, by: missile.owner });
        updateUi();
        if (target.health === 0) {
          scheduleRespawn(target, missile.owner);
        }
      }
    }
  }
}

function updateStars() {
  for (const star of stars) {
    star.x -= star.speed;
    if (star.x < 0) {
      star.x = canvas.width + Math.random() * 40;
      star.y = Math.random() * canvas.height;
    }
  }
}

function updateRespawns() {
  for (const [id, timer] of pendingRespawns.entries()) {
    const next = timer - 1;
    if (next <= 0) {
      const player = players.get(id);
      if (player) {
        respawnPlayer(player);
      }
      pendingRespawns.delete(id);
    } else {
      pendingRespawns.set(id, next);
    }
  }
}

function drawPlane(player) {
  const level = PLANE_LEVELS[player.level];
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(player.angle);
  ctx.fillStyle = player.isLocal ? "#65d6ff" : "#ff5f7a";
  ctx.beginPath();
  ctx.moveTo(26, 0);
  ctx.lineTo(-20, -12);
  ctx.lineTo(-12, 0);
  ctx.lineTo(-20, 12);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.beginPath();
  ctx.arc(-10, 0, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  drawHealthBar(player, level);
}

function drawHealthBar(player, level) {
  const barWidth = 60;
  const barHeight = 6;
  const x = player.x - barWidth / 2;
  const y = player.y - 38;
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(x, y, barWidth, barHeight);
  const ratio = player.health / level.armor;
  ctx.fillStyle = player.isLocal ? "#65d6ff" : "#ff5f7a";
  ctx.fillRect(x, y, barWidth * ratio, barHeight);
}

function drawMissiles() {
  ctx.fillStyle = "#ffd56a";
  for (const missile of missiles) {
    ctx.beginPath();
    ctx.arc(missile.x, missile.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawStars() {
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  for (const star of stars) {
    ctx.fillRect(star.x, star.y, star.size, star.size);
  }
}

function drawStatusText() {
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.font = "14px sans-serif";
  const text = connectionReady
    ? "Connected opponent"
    : "Play solo or connect to a lobby";
  ctx.fillText(text, 18, 26);
}

function gameLoop(timestamp) {
  const delta = timestamp - lastTime;
  if (delta < 14) {
    requestAnimationFrame(gameLoop);
    return;
  }
  lastTime = timestamp;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  updateStars();
  drawStars();

  updatePlayer(localPlayer);
  updateMissiles();
  updateRespawns();

  drawPlane(localPlayer);
  if (remotePlayer.connected) {
    drawPlane(remotePlayer);
  }
  drawMissiles();
  drawStatusText();

  if (connectionReady) {
    sendState();
  }

  updateUi();
  requestAnimationFrame(gameLoop);
}

window.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
  }
  keyState.add(event.code);
});

window.addEventListener("keyup", (event) => {
  keyState.delete(event.code);
});

upgradeBtn.addEventListener("click", () => {
  const nextLevel = PLANE_LEVELS[localPlayer.level + 1];
  if (!nextLevel || localPlayer.gold < nextLevel.cost) {
    return;
  }
  localPlayer.gold -= nextLevel.cost;
  localPlayer.level += 1;
  localPlayer.maxHealth = nextLevel.armor;
  localPlayer.health = Math.min(localPlayer.health + 20, localPlayer.maxHealth);
  updateUi();
});

hostBtn.addEventListener("click", () => {
  hostLobby().catch(console.error);
});

joinBtn.addEventListener("click", () => {
  joinLobby().catch(console.error);
});

createResponseBtn.addEventListener("click", () => {
  joinLobby().catch(console.error);
});

applyResponseBtn.addEventListener("click", () => {
  applyResponse().catch(console.error);
});

updateUi();
requestAnimationFrame(gameLoop);

if (typeof RTCPeerConnection === "undefined") {
  setMultiplayerAvailability(false, "WebRTC not supported");
} else if (!window.isSecureContext) {
  setMultiplayerAvailability(false, "HTTPS required for multiplayer");
} else {
  setMultiplayerAvailability(true, "Ready to connect");
  setHint("Share the lobby code with another device and paste their response.");
}
