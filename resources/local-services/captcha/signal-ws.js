"use strict";

/**
 * signal-ws.js — Local signal WebSocket channel for the BLS extension.
 *
 * Ports the signal WebSocket logic from the Python server (server.py) so the
 * extension's `ws://localhost:3001/` (root) and `ws://localhost:3001/ws`
 * connections are served locally. The old Node server.js only served
 * `/api/ws` (the sync command channel); the extension also dials the root
 * path for cross-tab signals (massSubmit, changeProxyAll, distributeGuessTime,
 * seqSeconds, bypassBreach, startAll, stopAll ...).
 *
 * Wire format: standard RFC 6455 WebSocket frames (text, masked from client).
 * Message envelope the extension uses: { type:"message", message:"<name>Ping" }
 * and handshake: { type:"handshake request", userId, tabId, country, visaType }.
 *
 * Exports:
 *   handleSignalUpgrade(req, socket)  -> boolean (true if this request was handled)
 *   getSignalClientCount()            -> number of connected signal clients
 */

const crypto = require("crypto");

const SIGNAL_COOLDOWN_MS = parseInt(process.env.SIGNAL_COOLDOWN_MS || "1000", 10);
const BYPASS_BREACH_PONG_COOLDOWN_MS = parseInt(process.env.BYPASS_BREACH_PONG_COOLDOWN_MS || "3000", 10);
const MAX_SIGNAL_MESSAGE_BYTES = 2 * 1024 * 1024;
function normalizePeerAddress(value) {
  let out = String(value || "").trim().toLowerCase();
  if (out.startsWith("::ffff:")) out = out.slice(7);
  if (out === "::1") out = "127.0.0.1";
  return out;
}

function isLoopbackPeer(value) {
  const v = normalizePeerAddress(value);
  return v === "127.0.0.1" || v === "localhost" || v === "";
}

function tuneSignalSocket(socket) {
  try { socket?.setNoDelay?.(true); } catch (_) {}
  try { socket?.setKeepAlive?.(true, 15000); } catch (_) {}
}

// ---------------------------- Client registry ----------------------------

const signalClients = new Set();           // Set<SignalClient> (legacy/background sockets)
const userGroups = new Map();              // groupId -> Set<SignalClient>
const lastSignalSent = new Map();          // `${groupId}\u0000${signalType}` -> ms
const lastBypassCountry = new Map();       // country -> ms

class SignalClient {
  constructor(socket) {
    this.socket = socket;
    this.peerAddress = normalizePeerAddress(socket?.remoteAddress);
    this.isRemotePeer = !isLoopbackPeer(this.peerAddress);
    this.userId = "";
    this.tabId = "";
    this.country = "";
    this.visaType = "";
    this.center = "";
    this.computerGroupKey = "";
    this.seqProfileNo = 0;
    this.seqPage = "";
    this.seqModeOn = false;
    this.seqStep = 1;
    this.seqStepMs = 100;
    this.seqUseSecondStep = true;
    this.seqUseMsStep = false;
    this.seqAssignedHour = -1;
    this.seqAssignedMinute = -1;
    this.seqAssignedSecond = -1;
    this.seqAssignedMs = -1;
    this.seqAnchorProfileNo = 0;
    this.seqOrderIndex = -1;
    this.seqUpdatedAt = 0;
    this.connectedAt = Date.now();
    this.allowMasterSignal = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.fragmentOpcode = null;
  }

  get groupId() {
    const parts = [this.userId, this.country.toLowerCase(), this.visaType, this.computerGroupKey];
    return parts.filter(Boolean).join("|");
  }
}

// ---------------------------- WebSocket framing ----------------------------

function wsFrame(opcode, payloadBuffer = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(payloadBuffer) ? payloadBuffer : Buffer.from(payloadBuffer);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, payload]);
}

function wsSendJson(client, obj) {
  const socket = client.socket;
  if (!socket || socket.destroyed || !socket.writable) return false;
  try {
    socket.write(wsFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8")));
    return true;
  } catch (_) {
    return false;
  }
}

function processSignalBuffer(client) {
  let buf = client.buffer || Buffer.alloc(0);
  while (buf.length >= 2) {
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_SIGNAL_MESSAGE_BYTES)) return client.socket.destroy();
      len = Number(big);
      offset = 10;
    }
    if (len > MAX_SIGNAL_MESSAGE_BYTES) return client.socket.destroy();
    const maskBytes = masked ? 4 : 0;
    if (buf.length < offset + maskBytes + len) break;
    let mask = null;
    if (masked) {
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    buf = buf.subarray(offset + len);
    if (masked) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }

    if (opcode === 0x8) {
      try { client.socket.write(wsFrame(0x8)); } catch (_) {}
      client.socket.end();
      break;
    }
    if (opcode === 0x9) {
      try { client.socket.write(wsFrame(0xA, payload)); } catch (_) {}
      continue;
    }
    if (opcode === 0xA) continue;

    if (opcode === 0x1) {
      client.fragments = [payload];
      client.fragmentOpcode = opcode;
    } else if (opcode === 0x0 && client.fragments) {
      client.fragments.push(payload);
    } else {
      continue;
    }

    if (fin && client.fragments) {
      const message = Buffer.concat(client.fragments);
      client.fragments = null;
      client.fragmentOpcode = null;
      if (message.length <= MAX_SIGNAL_MESSAGE_BYTES) {
        let parsed = null;
        try {
          parsed = JSON.parse(message.toString("utf8"));
        } catch (_) {
          wsSendJson(client, { type: "error", error: "Invalid message format" });
          continue;
        }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          handleSignal(client, parsed).catch(() => {});
        } else {
          wsSendJson(client, { type: "error", error: "Invalid message format" });
        }
      }
    }
  }
  client.buffer = buf;
}

// ---------------------------- Helpers (ported from server.py) ----------------------------

function toInt(value, def = 0) {
  try {
    if (value === null || value === undefined || value === "") return def;
    return parseInt(String(parseFloat(value)), 10);
  } catch (_) {
    return def;
  }
}

function messageType(payload) {
  const t = String(payload.type || "");
  if (t === "message") return String(payload.message || payload.action || "");
  return String(payload.event || payload.action || t || "");
}

function isHandshake(payload) {
  const t = String(payload.type || "").toLowerCase();
  const m = String(payload.message || "").toLowerCase();
  return t.includes("handshake") || m.includes("handshake");
}

function normalizeHandshake(payload) {
  let data = payload.connectionData && typeof payload.connectionData === "object" ? { ...payload.connectionData } : { ...payload };
  if (payload.payload && typeof payload.payload === "object") data = { ...data, ...payload.payload };
  return data;
}

function computerGroupFromPayload(payload) {
  const data = normalizeHandshake(payload);
  const value = data.computerGroupKey || data.computerGroup || data.deviceGroup || data.computerId || data.machineId || "";
  return String(value || "").trim().slice(0, 100);
}

function profileNumberFromPayload(payload) {
  const data = normalizeHandshake(payload);
  const raw = data.seqProfileNo || data.profileNo || data.profileNumber || data.profile_no;
  return Math.max(0, Math.min(99, toInt(raw, 0)));
}

function seqSortKey(client) {
  if (client.seqProfileNo > 0) {
    return [0, client.seqProfileNo, client.connectedAt, String(client.tabId), 0];
  }
  return [1, 9999, client.connectedAt, String(client.tabId), 0];
}

function compareSeqSortKey(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[2] !== b[2]) return a[2] - b[2];
  if (a[3] < b[3]) return -1;
  if (a[3] > b[3]) return 1;
  return 0;
}

function seqTimeParts(baseHour, baseMinute, baseSecond, baseMs, offsetMs) {
  const dayMs = 24 * 60 * 60 * 1000;
  let total = ((baseHour * 3600 + baseMinute * 60 + baseSecond) * 1000 + baseMs + offsetMs) % dayMs;
  if (total < 0) total += dayMs;
  const hh = Math.floor(total / 3600000); total %= 3600000;
  const mm = Math.floor(total / 60000); total %= 60000;
  const ss = Math.floor(total / 1000);
  const ms = total % 1000;
  return [hh, mm, ss, ms];
}

function boolish(value, def = true) {
  if (value === undefined || value === null) return def;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
}

function updateSeqClientState(client, payload, modeOn) {
  const profileNo = profileNumberFromPayload(payload);
  if (profileNo > 0) client.seqProfileNo = profileNo;
  if (modeOn !== undefined && modeOn !== null) client.seqModeOn = boolish(modeOn, false);
  if ("step" in payload) client.seqStep = Math.max(0, Math.min(30, toInt(payload.step, client.seqStep)));
  if ("stepMs" in payload) client.seqStepMs = Math.max(0, Math.min(999, toInt(payload.stepMs, client.seqStepMs)));
  if ("useSecondStep" in payload) client.seqUseSecondStep = !(payload.useSecondStep === false || String(payload.useSecondStep).toLowerCase() === "false");
  if ("useMsStep" in payload) client.seqUseMsStep = boolish(payload.useMsStep, false);
  if (!client.seqUseSecondStep && !client.seqUseMsStep) client.seqUseSecondStep = true;
  const page = String(payload.targetPage || payload.page || "").trim().toLowerCase();
  if (page) client.seqPage = page;
  const cgk = computerGroupFromPayload(payload);
  if (cgk) client.computerGroupKey = cgk;
  if ("assignedHour" in payload) client.seqAssignedHour = Math.max(0, Math.min(23, toInt(payload.assignedHour, client.seqAssignedHour)));
  if ("assignedMinute" in payload) client.seqAssignedMinute = Math.max(0, Math.min(59, toInt(payload.assignedMinute, client.seqAssignedMinute)));
  if ("assignedSecond" in payload) client.seqAssignedSecond = Math.max(0, Math.min(59, toInt(payload.assignedSecond, client.seqAssignedSecond)));
  if ("assignedMs" in payload) client.seqAssignedMs = Math.max(0, Math.min(999, toInt(payload.assignedMs, client.seqAssignedMs)));
  client.seqUpdatedAt = Date.now();
}

function seqProfileRows(group, now) {
  if (now === undefined) now = Date.now();
  const rows = [];
  const sorted = [...group].sort(compareSeqSortKey);
  sorted.forEach((c, idx) => {
    const age = c.seqUpdatedAt ? Math.max(0, now - c.seqUpdatedAt) : null;
    let assigned = "";
    if (c.seqAssignedHour >= 0 && c.seqAssignedMinute >= 0 && c.seqAssignedSecond >= 0 && c.seqAssignedMs >= 0) {
      const pad = (n, l = 2) => String(n).padStart(l, "0");
      assigned = `${pad(c.seqAssignedHour)}:${pad(c.seqAssignedMinute)}:${pad(c.seqAssignedSecond)}.${pad(c.seqAssignedMs, 3)}`;
    }
    rows.push({
      profileNo: c.seqProfileNo,
      orderIndex: idx,
      tabId: c.tabId,
      page: c.seqPage,
      modeOn: c.seqModeOn,
      assignedTime: assigned,
      assignedHour: c.seqAssignedHour,
      assignedMinute: c.seqAssignedMinute,
      assignedSecond: c.seqAssignedSecond,
      assignedMs: c.seqAssignedMs,
      step: c.seqStep,
      stepMs: c.seqStepMs,
      useSecondStep: c.seqUseSecondStep,
      useMsStep: c.seqUseMsStep,
      anchorProfileNo: c.seqAnchorProfileNo,
      updatedAgoMs: age,
      connectedAgoMs: Math.max(0, now - c.connectedAt),
      status: c.seqProfileNo > 0 ? "Ready" : "No number",
    });
  });
  return rows;
}

function removeClient(client, close = false) {
  signalClients.delete(client);
  for (const key of [...userGroups.keys()]) {
    const set = userGroups.get(key);
    set.delete(client);
    if (set.size === 0) userGroups.delete(key);
  }
  if (close && client.socket && !client.socket.destroyed) {
    try { client.socket.destroy(); } catch (_) {}
  }
}


const SPAIN_CENTER_IDS = Object.freeze({
  "138660df-f645-488f-8458-97186b17c7f9": "AGADIR",
  "0566245a-7ba1-4b5a-b03b-3dd33e051f46": "NADOR",
  "60d2df036755e8de168d8db7": "CASABLANCA",
  "8d780684-1524-4bda-b138-7c71a8591944": "RABAT",
  "889689b5-1099-4795-ac19-c9263da23252": "TETOUAN",
  "8457a52e-98be-4860-88fc-2ce11b80a75e": "TANGIER",
});

function normalizeSpainCenter(value) {
  if (value == null) return "";
  let raw = "";
  if (typeof value === "object") {
    raw = String(value.Name || value.name || value.Text || value.text || value.Value || value.value || value.Id || value.id || "");
  } else {
    raw = String(value);
  }
  raw = raw.trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  for (const [id, center] of Object.entries(SPAIN_CENTER_IDS)) {
    if (lower.includes(id)) return center;
  }
  const upper = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  if (upper.includes("CASABLANCA")) return "CASABLANCA";
  if (upper.includes("TANGIER") || upper.includes("TANGER")) return "TANGIER";
  if (upper.includes("TETOUAN") || upper.includes("TETUAN")) return "TETOUAN";
  if (upper.includes("AGADIR")) return "AGADIR";
  if (upper.includes("RABAT")) return "RABAT";
  if (upper.includes("NADOR")) return "NADOR";
  return "";
}

function centerFromHandshakeData(data, visaType = "") {
  const candidates = [
    data?.center, data?.centerName, data?.centre, data?.centreName,
    data?.location, data?.locationName, data?.mission, data?.missionName,
    data?.vac, data?.vacName, visaType,
  ];
  for (const value of candidates) {
    const center = normalizeSpainCenter(value);
    if (center) return center;
  }
  return "";
}

function registerClient(client, payload) {
  const data = normalizeHandshake(payload);
  const userId = String(data.userId || data.user_id || "").trim();
  const tabId = String(data.tabId || data.tab_id || "").trim();
  const country = String(data.country || "").trim().toLowerCase();
  const visaType = String(data.visaType || data.visaTypeF || data.visatype || "").trim();
  const center = centerFromHandshakeData(data, visaType);
  const computerGroupKey = computerGroupFromPayload(data);

  if (!(userId && tabId && country && visaType)) return false;

  // Replace any old connection with the same user/tab/group.
  for (const other of [...signalClients]) {
    if (other !== client &&
        other.userId === userId && other.tabId === tabId &&
        other.country === country && other.visaType === visaType &&
        other.computerGroupKey === computerGroupKey) {
      try { wsSendJson(other, { type: "message", message: "replaced" }); } catch (_) {}
      removeClient(other, true);
    }
  }

  removeClient(client, false);
  client.userId = userId;
  client.tabId = tabId;
  client.country = country;
  client.visaType = visaType;
  client.center = center;
  client.computerGroupKey = computerGroupKey;
  client.seqProfileNo = profileNumberFromPayload(data);
  client.seqPage = String(data.targetPage || data.page || "").trim().toLowerCase();
  client.seqUpdatedAt = Date.now();
  client.allowMasterSignal = boolish(data.allowMasterSignal || data.allow_master_signal, false);
  signalClients.add(client);
  if (!userGroups.has(client.groupId)) userGroups.set(client.groupId, new Set());
  userGroups.get(client.groupId).add(client);
  return true;
}

function pongType(signalType) {
  const table = {
    massSubmitVisaTypePing: "massSubmitVisaTypePong",
    massSubmitConfirmationPing: "massSubmitConfirmationPong",
    changeProxyAllPing: "changeProxyAllPong",
    spoofIPAllPing: "spoofIPAllPong",
    disableProxyAllPing: "disableProxyAllPong",
    stopSessionAllPing: "stopSessionAllPong",
    bypassBreachPing: "bypassBreachPong",
    distributeGuessTimePing: "distributeGuessTimePong",
    startAllPing: "startAllPong",
    stopAllPing: "stopAllPong",
  };
  if (table[signalType]) return table[signalType];
  if (signalType.endsWith("Ping")) return signalType.slice(0, -4) + "Pong";
  return signalType;
}

function sendToGroup(sender, payload, excludeSender = true) {
  const group = userGroups.get(sender.groupId) || new Set();
  let sent = 0;
  for (const client of [...group]) {
    if (excludeSender && client === sender) continue;
    if (wsSendJson(client, payload)) sent += 1;
  }
  return sent;
}

function broadcastBypassByCountry(sender, payload) {
  const nowMs = Date.now();
  const country = sender.country.toLowerCase();
  if (nowMs - (lastBypassCountry.get(country) || 0) < BYPASS_BREACH_PONG_COOLDOWN_MS) return 0;
  lastBypassCountry.set(country, nowMs);
  let sent = 0;
  for (const client of [...signalClients]) {
    if (client === sender) continue;
    if (client.country.toLowerCase() === country) {
      if (wsSendJson(client, payload)) sent += 1;
    }
  }
  return sent;
}

function distributeGuessTime(sender, payload) {
  const group = [...(userGroups.get(sender.groupId) || new Set())].sort((a, b) => (a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0));
  if (!group.length) return 0;
  const baseDelay = toInt(payload.baseDelay != null ? payload.baseDelay : payload.delay, 0);
  const distributionOffset = toInt(payload.distributionOffset, 150);
  const nowMs = Date.now() + baseDelay;
  let sent = 0;
  group.forEach((client, index) => {
    const targetMs = nowMs + index * distributionOffset;
    const d = new Date(targetMs);
    const msg = { ...payload };
    msg.type = "message";
    msg.message = "distributeGuessTimePong";
    msg.newMinute = d.getUTCMinutes();
    msg.newSecond = d.getUTCSeconds();
    msg.newMilliseconds = d.getUTCMilliseconds();
    msg.clientTabId = client.tabId;
    msg.timestamp = targetMs;
    if (wsSendJson(client, msg)) sent += 1;
  });
  return sent;
}

function distributeSeqSeconds(sender, payload) {
  const senderProfileNo = profileNumberFromPayload(payload);
  if (senderProfileNo > 0) sender.seqProfileNo = senderProfileNo;
  updateSeqClientState(sender, payload, true);

  const group = [...(userGroups.get(sender.groupId) || new Set())].sort(compareSeqSortKey);
  if (!group.length) return 0;

  const baseHour = Math.max(0, Math.min(23, toInt(payload.baseHour, 0)));
  const baseMinute = Math.max(0, Math.min(59, toInt(payload.baseMinute, 0)));
  const baseSecond = toInt(payload.baseSecond, 0) % 60;
  const baseMs = Math.max(0, Math.min(999, toInt(payload.baseMs, 0)));
  const step = Math.max(0, Math.min(30, toInt(payload.step, 1)));
  const stepMs = Math.max(0, Math.min(999, toInt(payload.stepMs, 100)));
  let useSecondStep = !(payload.useSecondStep === false || String(payload.useSecondStep).toLowerCase() === "false");
  let useMsStep = boolish(payload.useMsStep, false);
  if (!useSecondStep && !useMsStep) useSecondStep = true;
  const total = group.length;
  const nowMs = Date.now();

  const anchorProfileNo = Math.max(0, Math.min(99, toInt(payload.anchorProfileNo, sender.seqProfileNo)));
  let anchorIndex = 0;
  let foundSender = false;
  group.forEach((client, index) => {
    if (client === sender) { anchorIndex = index; foundSender = true; }
  });
  if (!foundSender && anchorProfileNo > 0) {
    group.forEach((client, index) => {
      if (client.seqProfileNo === anchorProfileNo) anchorIndex = index;
    });
  }

  const assignments = new Map();
  group.forEach((client, index) => {
    const orderDistance = ((index - anchorIndex) % total + total) % total;
    const followOffsetSeconds = useSecondStep ? orderDistance * step : 0;
    const followOffsetMs = useMsStep ? orderDistance * stepMs : 0;
    const totalOffsetMs = followOffsetSeconds * 1000 + followOffsetMs;
    const [aH, aM, aS, aMs] = seqTimeParts(baseHour, baseMinute, baseSecond, baseMs, totalOffsetMs);
    client.seqModeOn = true;
    client.seqStep = step;
    client.seqStepMs = stepMs;
    client.seqUseSecondStep = useSecondStep;
    client.seqUseMsStep = useMsStep;
    client.seqAssignedHour = aH;
    client.seqAssignedMinute = aM;
    client.seqAssignedSecond = aS;
    client.seqAssignedMs = aMs;
    client.seqAnchorProfileNo = anchorProfileNo || sender.seqProfileNo;
    client.seqOrderIndex = index;
    client.seqUpdatedAt = Date.now();
    assignments.set(client, { followOffsetSeconds, followOffsetMs, aH, aM, aS, aMs });
  });

  const groupProfiles = seqProfileRows(group);
  let sent = 0;
  group.forEach((client, index) => {
    const a = assignments.get(client) || {};
    const followOffsetSeconds = a.followOffsetSeconds || 0;
    const followOffsetMs = a.followOffsetMs || 0;
    const aS = a.aS != null ? a.aS : baseSecond;
    const aMs = a.aMs != null ? a.aMs : baseMs;
    const aH = a.aH != null ? a.aH : baseHour;
    const aM = a.aM != null ? a.aM : baseMinute;
    const msOnly = !useSecondStep && useMsStep;
    const msg = { ...payload };
    msg.type = "message";
    msg.message = "seqSecondsPong";
    msg.baseHour = baseHour;
    msg.baseMinute = baseMinute;
    msg.baseSecond = baseSecond;
    msg.baseMs = baseMs;
    msg.assignedHour = aH;
    msg.assignedMinute = aM;
    msg.assignedSecond = aS;
    msg.assignedMs = aMs;
    msg.step = step;
    msg.stepMs = stepMs;
    msg.useSecondStep = useSecondStep;
    msg.useMsStep = useMsStep;
    msg.forceSameSecond = false;
    msg.msOnly = msOnly;
    msg.profileNo = client.seqProfileNo;
    msg.orderIndex = index;
    msg.anchorOrderIndex = anchorIndex;
    msg.anchorProfileNo = anchorProfileNo || sender.seqProfileNo;
    msg.followOffsetSeconds = followOffsetSeconds;
    msg.followOffsetMs = followOffsetMs;
    msg.totalProfiles = total;
    msg.clientTabId = client.tabId;
    msg.timestamp = nowMs;
    msg.fromTabId = sender.tabId;
    msg.senderProfileNo = sender.seqProfileNo;
    msg.userGroupId = sender.groupId;
    msg.manualOrderStrict = true;
    msg.followAnchor = true;
    msg.loop = true;
    msg.groupProfiles = groupProfiles;
    if (wsSendJson(client, msg)) sent += 1;
  });
  return sent;
}

function syncSeqSecondsControl(sender, payload) {
  const senderProfileNo = profileNumberFromPayload(payload);
  if (senderProfileNo > 0) sender.seqProfileNo = senderProfileNo;
  updateSeqClientState(sender, payload, payload.modeOn);

  const step = Math.max(0, Math.min(30, toInt(payload.step, 1)));
  const stepMs = Math.max(0, Math.min(999, toInt(payload.stepMs, 100)));
  let useSecondStep = !(payload.useSecondStep === false || String(payload.useSecondStep).toLowerCase() === "false");
  let useMsStep = boolish(payload.useMsStep, false);
  if (!useSecondStep && !useMsStep) useSecondStep = true;
  const modeOn = boolish(payload.modeOn, false);
  if (payload.registerOnly === true || String(payload.registerOnly).toLowerCase() === "true") return 0;
  const nowMs = Date.now();
  const group = [...(userGroups.get(sender.groupId) || new Set())].sort(compareSeqSortKey);
  for (const client of group) {
    client.seqModeOn = modeOn;
    client.seqStep = step;
    client.seqStepMs = stepMs;
    client.seqUseSecondStep = useSecondStep;
    client.seqUseMsStep = useMsStep;
    client.seqUpdatedAt = Date.now();
  }
  const groupProfiles = seqProfileRows(group);
  let sent = 0;
  for (const client of group) {
    if (client === sender) continue;
    const msg = { ...payload };
    msg.type = "message";
    msg.message = "seqSecondsControlPong";
    msg.modeOn = modeOn;
    msg.step = step;
    msg.stepMs = stepMs;
    msg.useSecondStep = useSecondStep;
    msg.useMsStep = useMsStep;
    msg.timestamp = nowMs;
    msg.fromTabId = sender.tabId;
    msg.senderProfileNo = sender.seqProfileNo;
    msg.userGroupId = sender.groupId;
    msg.groupProfiles = groupProfiles;
    if (wsSendJson(client, msg)) sent += 1;
  }
  return sent;
}

function monitorSeqSeconds(sender, payload) {
  updateSeqClientState(sender, payload, "modeOn" in payload ? payload.modeOn : sender.seqModeOn);
  const group = [...(userGroups.get(sender.groupId) || new Set())].sort(compareSeqSortKey);
  const rows = seqProfileRows(group);
  const nowMs = Date.now();
  let sent = 0;
  for (const client of group) {
    const msg = { ...payload };
    msg.type = "message";
    msg.message = "seqSecondsMonitorPong";
    msg.timestamp = nowMs;
    msg.fromTabId = sender.tabId;
    msg.senderProfileNo = sender.seqProfileNo;
    msg.userGroupId = sender.groupId;
    msg.groupProfiles = rows;
    msg.totalProfiles = rows.length;
    if (wsSendJson(client, msg)) sent += 1;
  }
  return sent;
}

async function handleSignal(sender, payload) {
  if (isHandshake(payload)) {
    const ok = registerClient(sender, payload);
    wsSendJson(sender, {
      type: "message",
      message: ok ? "handshake_accorded" : "handshake_skipped",
      numberOfConnections: signalClients.size,
      userGroupId: sender.groupId,
    });
    return;
  }

  const signalType = messageType(payload);
  if (!signalType) return;

  if (!sender.groupId) registerClient(sender, payload);
  if (!sender.groupId) return;

  const profileNo = profileNumberFromPayload(payload);
  if (profileNo > 0) sender.seqProfileNo = profileNo;

  const nowMs = Date.now();
  const cooldownKey = `${sender.groupId}\u0000${signalType}`;
  const noCooldown = new Set(["distributeGuessTimePing", "seqSecondsPing", "seqSecondsControlPing", "seqSecondsMonitorPing"]);
  const remaining = SIGNAL_COOLDOWN_MS - (nowMs - (lastSignalSent.get(cooldownKey) || 0));
  if (remaining > 0 && !noCooldown.has(signalType)) return;
  lastSignalSent.set(cooldownKey, nowMs);

  const pongName = pongType(signalType);
  const out = { ...payload };
  out.type = "message";
  out.message = pongName;
  out.timestamp = nowMs;
  out.fromTabId = sender.tabId;
  out.userGroupId = sender.groupId;

  let sent;
  if (signalType === "distributeGuessTimePing") {
    sent = distributeGuessTime(sender, payload);
  } else if (signalType === "seqSecondsPing") {
    sent = distributeSeqSeconds(sender, payload);
  } else if (signalType === "seqSecondsControlPing") {
    sent = syncSeqSecondsControl(sender, payload);
  } else if (signalType === "seqSecondsMonitorPing") {
    sent = monitorSeqSeconds(sender, payload);
  } else if (signalType === "bypassBreachPing") {
    sent = broadcastBypassByCountry(sender, out);
  } else {
    sent = sendToGroup(sender, out, true);
  }

  wsSendJson(sender, { type: "message", message: pongName + "Ack", recipients: sent, timestamp: Date.now() });
}

// ---------------------------- Upgrade entry point ----------------------------

function handleSignalUpgrade(req, socket) {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = requestUrl.pathname;
  if (pathname !== "/" && pathname !== "/ws") return false;

  tuneSignalSocket(socket);

  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade || "").toLowerCase();
  if (!key || upgrade !== "websocket") return false;

  const accept = crypto
    .createHash("sha1")
    .update(String(key) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    "\r\n"
  );

  const client = new SignalClient(socket);
  signalClients.add(client);
  wsSendJson(client, { type: "message", message: "connected", timestamp: Date.now() });

  socket.on("data", (chunk) => {
    if (!signalClients.has(client)) return;
    client.buffer = Buffer.concat([client.buffer || Buffer.alloc(0), chunk]);
    if (client.buffer.length > MAX_SIGNAL_MESSAGE_BYTES + 65536) return socket.destroy();
    processSignalBuffer(client);
  });

  const cleanup = () => removeClient(client, false);
  socket.on("close", cleanup);
  socket.on("end", cleanup);
  socket.on("error", cleanup);
  return true;
}

function getSignalClientCount() {
  return signalClients.size;
}

function getSignalClientCenterCounts() {
  const counts = {};
  for (const client of [...signalClients]) {
    const center = client.center || normalizeSpainCenter(client.visaType) || "UNKNOWN";
    counts[center] = (counts[center] || 0) + 1;
  }
  return counts;
}

module.exports = {
  handleSignalUpgrade,
  getSignalClientCount,
  getSignalClientCenterCounts,
};
