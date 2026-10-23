const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { performance } = require("perf_hooks");

// Local ONNX captcha solver dependencies (replaces the remote NoCaptchaAI provider).
const ort = require("onnxruntime-node");
const sharp = require("sharp");

// Local signal WebSocket channel (root "/" + "/ws") — ports the Python server's
// signal WS so cross-tab signals (massSubmit, changeProxyAll, distributeGuessTime,
// seqSeconds, bypassBreach ...) work locally. The old Node server only served
// /api/ws (sync commands); the extension also dials the root path for signals.
const signalWs = require("./signal-ws");
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "127.0.0.1";
const SERVER_LOG_LEVEL = String(process.env.SERVER_LOG_LEVEL || process.env.LOG_LEVEL || "compact").toLowerCase();
const VERBOSE_LOG = ["verbose", "debug", "full"].includes(SERVER_LOG_LEVEL);
const SILENT_LOG = ["silent", "none", "off"].includes(SERVER_LOG_LEVEL);

// ── Local ONNX model configuration ──────────────────────────────────────────
// The BLS Spain captcha is a 3-digit number grid. The local model is a small
// CNN (input 3x80x150, three 10-class softmax heads digit0/digit1/digit2).
const IMG_WIDTH = 150;
const IMG_HEIGHT = 80;
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];
const DEFAULT_MODEL_PATH = path.join(__dirname, "models", "model.onnx");
const MODEL_PATH = process.env.MODEL_PATH
  ? path.resolve(process.env.MODEL_PATH)
  : DEFAULT_MODEL_PATH;
const ONNX_EXECUTION_PROVIDERS = String(process.env.ONNX_EXECUTION_PROVIDERS || "cpu")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Optional local access-token protection for the local captcha endpoint.
const REQUIRE_ACCESS_TOKEN = ["1", "true", "yes", "on"].includes(String(process.env.REQUIRE_ACCESS_TOKEN || "").toLowerCase());
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";

// Concurrency for local inference (the ONNX session is CPU-bound; keep modest).
const MAX_CONCURRENT_PROVIDER_REQUESTS = Math.max(1, Number(process.env.MAX_CONCURRENT_PROVIDER_REQUESTS || 2));

// Semantic Retry: re-run local inference when a target exists but nothing was
// selected (image preprocessing jitter can occasionally flip a digit).
const SEMANTIC_RETRY_MAX = Math.max(0, Number(process.env.SEMANTIC_RETRY_MAX || 1));
const SEMANTIC_RETRY_DELAY_MS = Math.max(0, Number(process.env.SEMANTIC_RETRY_DELAY_MS || 500));

class ProviderError extends Error {
  constructor(message, code = "PROVIDER_ERROR", details = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.details = details;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-access-token, x-access-uuid, x-tenant-id, x-license-key, x-user-id, x-user-name, x-device-id",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 35 * 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

function extractImages(body) {
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.images)) return body.images.map((x) => x && (x.image || x.src || x.data || x));
  if (Array.isArray(body.tiles)) return body.tiles.map((x) => x && (x.image || x.src || x.data || x));
  return [];
}

function extractIds(body) {
  if (Array.isArray(body.ids)) return body.ids;
  if (Array.isArray(body.images)) return body.images.map((x) => x && x.id);
  if (Array.isArray(body.tiles)) return body.tiles.map((x) => x && x.id);
  return [];
}

function normalizeBase64Image(image) {
  return String(image || "").replace(/^data:image\/\w+;base64,/, "").trim();
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function elapsedMs(start) {
  return roundMs(performance.now() - start);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLikelyBase64(value) {
  const text = String(value || "").trim();
  return text.length > 0 && text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text);
}

function estimateBase64SizeBytes(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

function getImageInfo(image, index, id) {
  const raw = String(image || "");
  const normalized = normalizeBase64Image(raw);
  const validBase64 = isLikelyBase64(normalized);
  return {
    index,
    id: id || null,
    rawLength: raw.length,
    normalizedLength: normalized.length,
    hasDataImagePrefix: /^data:image\/\w+;base64,/.test(raw),
    validBase64,
    sizeBytes: validBase64 ? estimateBase64SizeBytes(normalized) : 0
  };
}

function extractTargetNumber(challenge) {
  const match = String(challenge || "").match(/\d+/);
  return match ? match[0] : "";
}

function getRawPreview(raw) {
  return String(raw || "").replace(/\s+/g, " ").slice(0, 240);
}

// ── Local ONNX captcha inference (replaces the remote NoCaptchaAI provider) ──
// Faithful Node port of the Python server's predict_one / decode_and_preprocess_to_chw.
// The model: input "input" [1,3,80,150]; outputs "digit0","digit1","digit2" each [1,10].

let _onnxSession = null;
let _onnxSessionPromise = null;

function findModelPath() {
  const candidates = [
    MODEL_PATH,
    DEFAULT_MODEL_PATH,
    path.join(process.cwd(), "models", "model.onnx"),
    path.join(process.cwd(), "model.onnx"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (_) {}
  }
  throw new ProviderError(
    "Could not find/read model.onnx. Set MODEL_PATH env var to an absolute path to the model.",
    "MODEL_NOT_FOUND",
    { tried: candidates }
  );
}

async function getOnnxSession() {
  if (_onnxSession) return _onnxSession;
  if (_onnxSessionPromise) return _onnxSessionPromise;
  _onnxSessionPromise = (async () => {
    const modelPath = findModelPath();
    const providers =
      ONNX_EXECUTION_PROVIDERS.length > 0
        ? ONNX_EXECUTION_PROVIDERS
        : ["cpu"];
    _onnxSession = await ort.InferenceSession.create(modelPath, { executionProviders: providers });
    _onnxSessionPromise = null;
    return _onnxSession;
  })();
  return _onnxSessionPromise;
}

function stripDataUrlPrefix(value) {
  const text = String(value || "");
  const lower = text.trim().toLowerCase();
  if (lower.startsWith("data:") && text.includes(",")) {
    return text.split(",", 2)[1];
  }
  return text;
}

// Decode a base64 (optionally data-URL prefixed) image and preprocess to a
// CHW float32 plane: resize to 150x80 (bilinear, matching PIL's
// Image.Resampling.BILINEAR), scale to [0,1], normalize with ImageNet
// mean/std, transpose HWC -> CHW. Returns a Float32Array of length 3*80*150.
async function decodeAndPreprocess(base64Image) {
  const rawB64 = stripDataUrlPrefix(base64Image);
  if (!rawB64) throw new ProviderError("Empty base64 image", "PROVIDER_INVALID_IMAGE");
  let rawBuf;
  try {
    rawBuf = Buffer.from(rawB64, "base64");
  } catch (e) {
    throw new ProviderError("Invalid base64 image encoding", "PROVIDER_INVALID_IMAGE", { error: e.message });
  }
  let pixels;
  try {
    pixels = await sharp(rawBuf)
      .removeAlpha()
      .resize(IMG_WIDTH, IMG_HEIGHT, { fit: "fill", kernel: sharp.kernel.bilinear })
      .raw()
      .toBuffer();
  } catch (e) {
    throw new ProviderError("Unsupported image format or invalid image", "PROVIDER_INVALID_IMAGE", { error: e.message });
  }
  const planeSize = IMG_HEIGHT * IMG_WIDTH;
  const chw = new Float32Array(3 * planeSize);
  for (let c = 0; c < 3; c += 1) {
    const mean = IMAGENET_MEAN[c];
    const std = IMAGENET_STD[c];
    const base = c * planeSize;
    for (let i = 0; i < planeSize; i += 1) {
      const pixel = pixels[i * 3 + c] / 255.0;
      chw[base + i] = (pixel - mean) / std;
    }
  }
  return chw;
}

// Run one tile through the model and return the 3-digit OCR string.
async function predictOne(base64Image, prepared) {
  const session = await getOnnxSession();
  const chw = prepared || await decodeAndPreprocess(base64Image);
  const tensor = new ort.Tensor("float32", chw, [1, 3, IMG_HEIGHT, IMG_WIDTH]);
  const feeds = { [session.inputNames[0]]: tensor };
  const outputs = await session.run(feeds);
  let digits = "";
  for (const name of session.outputNames) {
    const t = outputs[name];
    if (!t || !t.data) {
      digits += "0";
      continue;
    }
    const arr = t.data;
    let maxIdx = 0;
    for (let i = 1; i < arr.length; i += 1) {
      if (arr[i] > arr[maxIdx]) maxIdx = i;
    }
    digits += String(maxIdx);
  }
  return digits;
}

// Local concurrency queue (ONNX CPU inference is bounded; mirrors the old
// provider queue shape so /api/predict and /health responses stay compatible).
let activeProviderRequests = 0;
const providerQueue = [];

function getQueueStatus() {
  return { maxConcurrent: MAX_CONCURRENT_PROVIDER_REQUESTS, active: activeProviderRequests, pending: providerQueue.length };
}

function enqueueProviderJob(job) {
  return new Promise((resolve, reject) => {
    providerQueue.push({ job, resolve, reject });
    drainProviderQueue();
  });
}

function drainProviderQueue() {
  while (activeProviderRequests < MAX_CONCURRENT_PROVIDER_REQUESTS && providerQueue.length) {
    const item = providerQueue.shift();
    activeProviderRequests += 1;
    Promise.resolve()
      .then(item.job)
      .then(item.resolve, item.reject)
      .finally(() => {
        activeProviderRequests -= 1;
        drainProviderQueue();
      });
  }
}

// The local model cannot be "in cooldown" — keep the shape for response parity.
function getCircuitStatus() {
  return {
    open: false,
    openUntil: null,
    remainingMs: 0,
    consecutiveFailures: 0,
    lastError: "",
    lastCode: "",
    localModel: true,
  };
}

// Solve a number-grid captcha locally: run each tile through the ONNX model,
// return an object shaped like the old NoCaptchaAI result so extractAnswers /
// buildSelectionResult and the /api/predict response stay unchanged.
async function solveNumberGridLocal(images, pageUrl, challenge) {
  const normalizedImages = images.map(normalizeBase64Image).filter(Boolean);
  if (!normalizedImages.length) {
    throw new ProviderError("No valid base64 images received", "PROVIDER_INVALID_IMAGE");
  }
  const startTime = performance.now();
  const answers = await enqueueProviderJob(async () => {
    // Decode independent tiles together; keep CPU inference bounded by the
    // existing job queue and preserve the original tile/result order.
    const prepared = await Promise.all(normalizedImages.map(image => decodeAndPreprocess(image).catch(() => null)));
    const texts = [];
    for (let index = 0; index < normalizedImages.length; index++) {
      try {
        if (!prepared[index]) throw new Error('Invalid tile image');
        const text = await predictOne(normalizedImages[index], prepared[index]);
        texts.push(text);
      } catch (e) {
        // Per-tile failure: record empty so selection still aligns by index.
        if (!SILENT_LOG) {
          console.warn(`[${new Date().toLocaleTimeString()}] local predict tile failed: ${e.message}`);
        }
        texts.push("");
      }
    }
    return texts;
  });
  const elapsed = roundMs(performance.now() - startTime);
  // Shape mirrors the old provider result: { solution: { text, answers } }.
  return {
    status: "ready",
    taskId: `local-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    solution: { text: answers, answers },
    answers,
    text: answers[0] || "",
    localModel: true,
    elapsedMs: elapsed,
  };
}

function extractAnswers(result) {
  const candidates = [
    result?.solution?.answers,
    result?.solution?.text,
    result?.solution,
    result?.answers,
    result?.text,
    result?.data
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) return value.map((x) => String(x || "").trim());
    if (typeof value === "string") return [value.trim()];
  }
  return [];
}

function buildSelectionResult(answers, targetNumber, ids) {
  const normalizedTarget = String(targetNumber || "").trim();
  const selectedIndices = [];
  const selectedIds = [];
  const selectedTexts = [];
  if (!normalizedTarget) return { selectedIndices, selectedIds, selectedTexts };
  answers.forEach((answer, index) => {
    const text = String(answer || "").trim();
    if (text === normalizedTarget) {
      selectedIndices.push(index);
      selectedIds.push(ids[index] || null);
      selectedTexts.push(text);
    }
  });
  return { selectedIndices, selectedIds, selectedTexts };
}

function printRequestLog(info) {
  if (SILENT_LOG) return;
  const selectedCount = Array.isArray(info.selectedIndices) ? info.selectedIndices.length : 0;
  const targetLabel = info.targetNumber || "missing";
  const typeLabel = info.pageType || "unknown";
  const totalLabel = `${info.elapsed}ms`;
  const apiLabel = info.timings && typeof info.timings.localInferenceMs === "number" ? `${info.timings.localInferenceMs}ms` : "n/a";
  if (!VERBOSE_LOG) {
    console.log(
      `[${new Date().toLocaleTimeString()}] /api/predict | type=${typeLabel} | images=${info.images.length} | ids=${info.ids.length} | target=${targetLabel} | selected=${selectedCount} | semanticRetry=${info.semanticAttempts || 0} | total=${totalLabel} | api=${apiLabel} | queue=${getQueueStatus().pending}`
    );
    if (!info.targetNumber) console.log("Warning: Target number is missing; no tile will be selected.");
    if (!info.ids.length) console.log("Warning: Tile IDs are missing; selectedIds will be null.");
    return;
  }
  console.log("======================================");
  console.log("Received /api/predict request at:", new Date().toLocaleTimeString());
  console.log("Mode:", info.mode);
  console.log("Page type:", info.pageType);
  console.log("Page URL:", info.pageUrl);
  console.log("Challenge:", info.challenge);
  console.log("Target number:", info.targetNumber);
  console.log("Images count:", info.images.length);
  console.log("IDs count:", info.ids.length);
  console.log("IDs:", info.ids);
  console.log("Access token exists:", info.accessTokenExists);
  console.log("Model path:", MODEL_PATH);
  console.log("Image infos:", info.imageInfos);
  console.log("Queue:", getQueueStatus());
  console.log("Circuit:", getCircuitStatus());
  console.log("Timings:", info.timings);
  console.log("Debug saving:", "disabled");
  console.log("Answers:", info.answers);
  console.log("Selected indices:", info.selectedIndices);
  console.log("Selected IDs:", info.selectedIds);
  console.log("Semantic retry attempts:", info.semanticAttempts || 0);
  if (!info.targetNumber) console.log("Warning:", "Target number is missing; no tile will be selected.");
  if (!info.ids.length) console.log("Warning:", "Tile IDs are missing; selectedIds will be null.");
  console.log("Elapsed:", info.elapsed, "ms");
  console.log("======================================");
}


// ─────────────────────────────────────────────────────────────────────────────
// LOCAL CLIENTS / PROXIES / ALL-COMMANDS SYNC
// Replaces https://sghir-clients-sync.fly.dev completely.
// Data is persisted OUTSIDE the extension folder so updates/replacements cannot
// wipe Clients/Proxies. Default on Windows:
//   %LOCALAPPDATA%\SGHIR_BLS_LOCAL_DATA\sync-data.json
// Override with BLS_LOCAL_DATA_DIR if desired. Legacy ./data/sync-data.json is
// migrated automatically on first run when the external file does not exist.
// ─────────────────────────────────────────────────────────────────────────────
const LEGACY_SYNC_DATA_DIR = path.join(__dirname, "data");
const LEGACY_SYNC_DATA_FILE = path.join(LEGACY_SYNC_DATA_DIR, "sync-data.json");
const DEFAULT_SYNC_DATA_ROOT = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "SGHIR_BLS_LOCAL_DATA")
  : path.join(os.homedir(), ".sghir-bls-local-data");
const SYNC_DATA_DIR = path.resolve(process.env.BLS_LOCAL_DATA_DIR || DEFAULT_SYNC_DATA_ROOT);
const SYNC_DATA_FILE = path.join(SYNC_DATA_DIR, "sync-data.json");
const MAX_WS_MESSAGE_BYTES = 2 * 1024 * 1024;

let syncState = { version: 1, tenants: {} };
let persistChain = Promise.resolve();
const wsPeers = new Map();

function safeSyncKey(value, fallback = "sghir-clients-private-sync-v1") {
  const text = String(value || "").trim().replace(/[^a-zA-Z0-9_.:@-]+/g, "_").slice(0, 180);
  return text || fallback;
}

function loadSyncState() {
  try {
    fs.mkdirSync(SYNC_DATA_DIR, { recursive: true });

    // One-time migration from older builds that kept the DB beside server.js.
    if (!fs.existsSync(SYNC_DATA_FILE) && fs.existsSync(LEGACY_SYNC_DATA_FILE)) {
      try {
        fs.copyFileSync(LEGACY_SYNC_DATA_FILE, SYNC_DATA_FILE);
        console.log(`[LOCAL-SYNC] Migrated legacy data to persistent storage: ${SYNC_DATA_FILE}`);
      } catch (migrationError) {
        console.warn(`[LOCAL-SYNC] Legacy data migration failed:`, migrationError.message);
      }
    }

    if (!fs.existsSync(SYNC_DATA_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(SYNC_DATA_FILE, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.tenants && typeof parsed.tenants === "object") {
      syncState = { version: 1, ...parsed, tenants: parsed.tenants };
    }
  } catch (error) {
    console.warn(`[LOCAL-SYNC] Could not load ${SYNC_DATA_FILE}:`, error.message);
  }
}

function persistSyncState() {
  const snapshot = JSON.stringify(syncState, null, 2);
  persistChain = persistChain
    .catch(() => null)
    .then(async () => {
      await fs.promises.mkdir(SYNC_DATA_DIR, { recursive: true });
      const tmp = `${SYNC_DATA_FILE}.tmp-${process.pid}-${Date.now()}`;
      await fs.promises.writeFile(tmp, snapshot, "utf8");
      await fs.promises.rename(tmp, SYNC_DATA_FILE);
    })
    .catch((error) => console.warn("[LOCAL-SYNC] Persist failed:", error.message));
  return persistChain;
}

function getTenantIdFromRequest(req, urlObj = null) {
  return safeSyncKey(
    req.headers["x-tenant-id"] ||
    urlObj?.searchParams?.get("tenant") ||
    "sghir-clients-private-sync-v1"
  );
}

function getTenantState(tenantId) {
  const key = safeSyncKey(tenantId);
  if (!syncState.tenants[key] || typeof syncState.tenants[key] !== "object") {
    syncState.tenants[key] = { clients: [], proxies: [], updatedAt: new Date().toISOString() };
  }
  const tenant = syncState.tenants[key];
  if (!Array.isArray(tenant.clients)) tenant.clients = [];
  if (!Array.isArray(tenant.proxies)) tenant.proxies = [];
  if (!tenant.centerSelections || typeof tenant.centerSelections !== "object" || Array.isArray(tenant.centerSelections)) {
    tenant.centerSelections = {};
  }
  return tenant;
}

function centerSelectionComputerKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "pc-default";
  return raw.replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 120) || "pc-default";
}

function getCenterSelectionRecord(tenant, computerGroupKey = "") {
  const key = centerSelectionComputerKey(computerGroupKey);
  const record = tenant?.centerSelections?.[key];
  if (!record || typeof record !== "object") return { center: "", updatedAt: "" };
  return {
    center: String(record.center || ""),
    updatedAt: String(record.updatedAt || ""),
  };
}

function setCenterSelectionRecord(tenant, computerGroupKey = "", center = "") {
  const key = centerSelectionComputerKey(computerGroupKey);
  const record = { center: String(center || ""), updatedAt: new Date().toISOString() };
  if (!tenant.centerSelections || typeof tenant.centerSelections !== "object" || Array.isArray(tenant.centerSelections)) {
    tenant.centerSelections = {};
  }
  tenant.centerSelections[key] = record;
  tenant.updatedAt = record.updatedAt;
  return { key, ...record };
}

function clientIdOf(client = {}) {
  return String(client.id || client._id || client.applicationId || client.customerId || "").trim();
}

function clientTimestamp(client = {}) {
  return Date.parse(client.updatedAt || client.deletedAt || client.createdAt || 0) || 0;
}

function normalizeServerClient(raw = {}) {
  const id = clientIdOf(raw) || `client-${crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2)}`;
  const now = new Date().toISOString();
  return {
    ...raw,
    id,
    _id: id,
    applicationId: id,
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
    deletedAt: raw.deletedAt || null,
  };
}

function upsertServerClient(tenant, raw = {}) {
  const incoming = normalizeServerClient(raw);
  const id = clientIdOf(incoming);
  const idx = tenant.clients.findIndex((c) => clientIdOf(c) === id);
  if (idx < 0) {
    tenant.clients.push(incoming);
    return incoming;
  }
  const existing = tenant.clients[idx] || {};
  // v40.1.8 conflict rule: the local server is authoritative. Never allow an
  // older full-record snapshot from another Chrome profile or an old offline
  // queue to overwrite a newer server record. This protects Surname and every
  // other field from stale-profile resurrection.
  const existingTs = clientTimestamp(existing);
  const incomingTs = clientTimestamp(incoming);
  if (existingTs > incomingTs) {
    return existing;
  }
  const merged = normalizeServerClient({ ...existing, ...incoming, id });
  tenant.clients[idx] = merged;
  return merged;
}

function updateServerClientSurname(tenant, id, surname) {
  const clientId = String(id || "").trim();
  if (!clientId) throw new Error("Missing client id");
  const nextSurname = String(surname == null ? "" : surname).trim();
  if (!nextSurname) throw new Error("Surname cannot be empty");
  const idx = tenant.clients.findIndex((c) => clientIdOf(c) === clientId);
  if (idx < 0 || tenant.clients[idx]?.deletedAt) throw new Error("Client not found");
  const now = new Date().toISOString();
  const saved = {
    ...tenant.clients[idx],
    id: clientId,
    _id: clientId,
    applicationId: clientId,
    surname: nextSurname,
    updatedAt: now,
  };
  tenant.clients[idx] = saved;
  return saved;
}

function deleteServerClients(tenant, ids = []) {
  const now = new Date().toISOString();
  const set = new Set((Array.isArray(ids) ? ids : [ids]).map((x) => String(x || "")).filter(Boolean));
  for (const id of set) {
    const idx = tenant.clients.findIndex((c) => clientIdOf(c) === id);
    const current = idx >= 0 ? tenant.clients[idx] : { id, _id: id, applicationId: id, createdAt: now };
    const tombstone = { ...current, id, _id: id, applicationId: id, deletedAt: now, updatedAt: now };
    if (idx >= 0) tenant.clients[idx] = tombstone;
    else tenant.clients.push(tombstone);
  }
  return [...set];
}

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

function wsSendJson(socket, obj) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  try {
    socket.write(wsFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8")));
    return true;
  } catch (_) {
    return false;
  }
}

function broadcastWsCommand(sender, data) {
  const senderMeta = wsPeers.get(sender) || {};
  const tenantId = safeSyncKey(data.tenantId || senderMeta.tenantId);
  const outgoing = {
    ...data,
    type: "command",
    tenantId,
    computerGroupKey: data.computerGroupKey || senderMeta.computerGroupKey || "",
    sourceDeviceId: data.sourceDeviceId || senderMeta.deviceId || "",
  };
  let delivered = 0;
  for (const [peer, meta] of wsPeers.entries()) {
    if (safeSyncKey(meta.tenantId) !== tenantId) continue;
    if (wsSendJson(peer, outgoing)) delivered += 1;
  }
  if (VERBOSE_LOG) console.log(`[LOCAL-SYNC] WS ${outgoing.command || "command"} -> ${delivered} peer(s)`);
  return delivered;
}

function broadcastCenterSelectionToPeers({ tenantId, computerGroupKey = "", center = "", commandId = "" } = {}) {
  const wantedTenant = safeSyncKey(tenantId);
  const wantedComputer = centerSelectionComputerKey(computerGroupKey);
  const id = String(commandId || `center-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`);
  const outgoing = {
    type: "command",
    command: "CENTER_SELECTION_UPDATED",
    id,
    tenantId: wantedTenant,
    computerGroupKey: wantedComputer,
    createdAt: new Date().toISOString(),
    payload: {
      center: String(center || ""),
      computerGroupKey: wantedComputer,
      source: "center-selection-http-broadcast",
    },
  };

  let delivered = 0;
  for (const [peer, meta] of wsPeers.entries()) {
    if (safeSyncKey(meta.tenantId) !== wantedTenant) continue;
    const peerComputer = centerSelectionComputerKey(meta.computerGroupKey || "");
    if (wantedComputer && peerComputer !== wantedComputer) continue;
    if (wsSendJson(peer, outgoing)) {
      delivered += 1;
      meta.lastSeenAt = Date.now();
      wsPeers.set(peer, meta);
    }
  }
  if (VERBOSE_LOG) console.log(`[LOCAL-SYNC] CENTER_SELECTION_UPDATED ${id} -> ${delivered} peer(s)`);
  return { delivered, commandId: id, computerGroupKey: wantedComputer };
}

// v40.2.5: OPEN ALL has a dedicated Dashboard-to-Dashboard bus.
// Do not depend on MV3 background service workers staying alive in 16 Chrome
// profiles. Each visible Settings/Dashboard page owns a small local WebSocket.
// One peer is selected per Profile ID, so duplicate Settings tabs in the same
// Chrome profile cannot trigger the same OPEN twice.
function broadcastOpenAllToDashboardPeers({ tenantId, computerGroupKey = "", commandId = "", sourceProfileId = "" } = {}) {
  const wantedTenant = safeSyncKey(tenantId);
  const wantedComputer = String(computerGroupKey || "");
  const id = String(commandId || `openall-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`);
  const outgoing = {
    type: "command",
    command: "OPEN_ALL_DASHBOARD_DIRECT",
    id,
    tenantId: wantedTenant,
    computerGroupKey: wantedComputer,
    createdAt: new Date().toISOString(),
    payload: {
      sourceProfileId: String(sourceProfileId || ""),
      source: "dashboard-http-broadcast",
    },
  };

  let delivered = 0;
  const profileIds = [];
  const seenProfileIds = new Set();

  // Prefer the most recently active socket for a duplicated Profile ID.
  const entries = [...wsPeers.entries()].sort((a, b) => Number(b[1]?.lastSeenAt || 0) - Number(a[1]?.lastSeenAt || 0));
  for (const [peer, meta] of entries) {
    if (safeSyncKey(meta.tenantId) !== wantedTenant) continue;
    if (String(meta.role || "") !== "dashboard-openall") continue;
    if (wantedComputer && String(meta.computerGroupKey || "") && String(meta.computerGroupKey || "") !== wantedComputer) continue;

    const profileId = String(meta.profileId || "").trim();
    if (!profileId || seenProfileIds.has(profileId)) continue;
    seenProfileIds.add(profileId);

    if (wsSendJson(peer, outgoing)) {
      delivered += 1;
      profileIds.push(profileId);
      meta.lastSeenAt = Date.now();
      wsPeers.set(peer, meta);
    }
  }

  if (VERBOSE_LOG || delivered < 1) {
    console.log(`[LOCAL-SYNC] OPEN_ALL_DASHBOARD_DIRECT ${id} -> ${delivered} dashboard profile(s): ${profileIds.join(",") || "none"}`);
  }
  return { delivered, profileIds, commandId: id };
}


// v40.2.6: direct CHANGE PROXY ALL bus. Each live BLS/retry page owns one
// lightweight WS peer. Select only one peer per Profile ID so duplicate tabs
// in the same Chrome profile cannot rotate twice.
function broadcastChangeProxyAllToPagePeers({ tenantId, computerGroupKey = "", commandId = "" } = {}) {
  const wantedTenant = safeSyncKey(tenantId);
  const wantedComputer = String(computerGroupKey || "");
  const id = String(commandId || `proxyall-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`);
  const outgoing = {
    type: "command",
    command: "CHANGE_PROXY_ALL_DIRECT",
    id,
    tenantId: wantedTenant,
    computerGroupKey: wantedComputer,
    createdAt: new Date().toISOString(),
    payload: { source: "proxy-all-http-broadcast" },
  };

  let delivered = 0;
  const profileIds = [];
  const seenProfileIds = new Set();
  const entries = [...wsPeers.entries()].sort((a, b) => Number(b[1]?.lastSeenAt || 0) - Number(a[1]?.lastSeenAt || 0));
  for (const [peer, meta] of entries) {
    if (safeSyncKey(meta.tenantId) !== wantedTenant) continue;
    if (String(meta.role || "") !== "bls-proxy-direct") continue;
    if (wantedComputer && String(meta.computerGroupKey || "") && String(meta.computerGroupKey || "") !== wantedComputer) continue;

    const profileId = String(meta.profileId || "").trim();
    if (!profileId || seenProfileIds.has(profileId)) continue;
    seenProfileIds.add(profileId);
    if (wsSendJson(peer, outgoing)) {
      delivered += 1;
      profileIds.push(profileId);
      meta.lastSeenAt = Date.now();
      wsPeers.set(peer, meta);
    }
  }

  if (VERBOSE_LOG || delivered < 1) {
    console.log(`[LOCAL-SYNC] CHANGE_PROXY_ALL_DIRECT ${id} -> ${delivered} profile(s): ${profileIds.join(",") || "none"}`);
  }
  return { delivered, profileIds, commandId: id };
}

function handleWsJson(socket, text) {
  let data;
  try { data = JSON.parse(text); } catch (_) { return; }
  if (!data || typeof data !== "object") return;
  const meta = wsPeers.get(socket) || {};
  if (data.type === "hello") {
    meta.deviceId = String(data.deviceId || meta.deviceId || "");
    meta.computerGroupKey = String(data.computerGroupKey || meta.computerGroupKey || "");
    meta.role = String(data.role || meta.role || "");
    meta.profileId = String(data.profileId || meta.profileId || "").trim();
    meta.instanceId = String(data.instanceId || meta.instanceId || "");
    meta.lastSeenAt = Date.now();
    wsPeers.set(socket, meta);
    return wsSendJson(socket, { type: "welcome", local: true, role: meta.role, profileId: meta.profileId, time: Date.now() });
  }
  if (data.type === "ping") {
    meta.lastSeenAt = Date.now();
    wsPeers.set(socket, meta);
    return wsSendJson(socket, { type: "pong", time: Date.now() });
  }
  if (data.type === "command" && data.command) return broadcastWsCommand(socket, data);
}

function processWsBuffer(socket) {
  const meta = wsPeers.get(socket);
  if (!meta) return;
  let buf = meta.buffer || Buffer.alloc(0);
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
      if (big > BigInt(MAX_WS_MESSAGE_BYTES)) return socket.destroy();
      len = Number(big);
      offset = 10;
    }
    if (len > MAX_WS_MESSAGE_BYTES) return socket.destroy();
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
      try { socket.write(wsFrame(0x8)); } catch (_) {}
      socket.end();
      break;
    }
    if (opcode === 0x9) {
      try { socket.write(wsFrame(0xA, payload)); } catch (_) {}
      continue;
    }
    if (opcode === 0xA) continue;

    if (opcode === 0x1) {
      meta.fragments = [payload];
      meta.fragmentOpcode = opcode;
    } else if (opcode === 0x0 && meta.fragments) {
      meta.fragments.push(payload);
    } else {
      continue;
    }

    if (fin && meta.fragments) {
      const message = Buffer.concat(meta.fragments);
      meta.fragments = null;
      meta.fragmentOpcode = null;
      if (message.length <= MAX_WS_MESSAGE_BYTES) handleWsJson(socket, message.toString("utf8"));
    }
  }
  meta.buffer = buf;
}

loadSyncState();

function getPublicError(error) {
  const code = error && error.code ? error.code : "SERVER_ERROR";
  if (code === "PROVIDER_COOLDOWN") {
    return {
      error: "CAPTCHA_PROVIDER_COOLDOWN",
      message: error.message,
      retryable: true,
      providerCode: code,
      details: error.details || getCircuitStatus()
    };
  }
  if (String(code).startsWith("PROVIDER_")) {
    return {
      error: "CAPTCHA_PROVIDER_UNSTABLE",
      message: error.message || "Captcha provider unstable",
      retryable: isRetryableProviderError(error),
      providerCode: code,
      details: error.details || {}
    };
  }
  return {
    error: error && error.message ? error.message : "Internal server error",
    retryable: false,
    providerCode: code,
    details: {}
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });

  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = requestUrl.pathname;

  if (req.method === "GET" && pathname === "/api/health") {
    const tenantId = getTenantIdFromRequest(req, requestUrl);
    const tenant = getTenantState(tenantId);
    return sendJson(res, 200, {
      status: true,
      ok: true,
      service: "sghir-local-sync",
      tenantId,
      clients: tenant.clients.filter((c) => !c.deletedAt).length,
      proxies: tenant.proxies.length,
      wsPeers: [...wsPeers.values()].filter((m) => safeSyncKey(m.tenantId) === tenantId).length,
      dataFile: SYNC_DATA_FILE,
      time: new Date().toISOString(),
    });
  }

  if (req.method === "POST" && pathname === "/api/open-all/broadcast") {
    try {
      const body = await readBody(req);
      const tenantId = safeSyncKey(body.tenantId || getTenantIdFromRequest(req, requestUrl));
      const computerGroupKey = String(body.computerGroupKey || "");
      const result = broadcastOpenAllToDashboardPeers({
        tenantId,
        computerGroupKey,
        commandId: body.commandId || "",
        sourceProfileId: body.sourceProfileId || "",
      });
      return sendJson(res, 200, {
        status: true,
        ...result,
        expectedProfiles: Number(body.expectedProfiles || 0) || undefined,
      });
    } catch (error) {
      return sendJson(res, 400, { status: false, message: error?.message || "OPEN ALL broadcast failed" });
    }
  }

  if (req.method === "POST" && pathname === "/api/change-proxy-all/broadcast") {
    try {
      const body = await readBody(req);
      const tenantId = safeSyncKey(body.tenantId || getTenantIdFromRequest(req, requestUrl));
      const computerGroupKey = String(body.computerGroupKey || "");
      const result = broadcastChangeProxyAllToPagePeers({
        tenantId,
        computerGroupKey,
        commandId: body.commandId || "",
      });
      return sendJson(res, 200, { status: true, ...result });
    } catch (error) {
      return sendJson(res, 400, { status: false, message: error?.message || "CHANGE PROXY ALL broadcast failed" });
    }
  }

  if (req.method === "GET" && pathname === "/api/center-selection") {
    const tenantId = getTenantIdFromRequest(req, requestUrl);
    const tenant = getTenantState(tenantId);
    const computerGroupKey = centerSelectionComputerKey(requestUrl.searchParams.get("computer") || "");
    const selection = getCenterSelectionRecord(tenant, computerGroupKey);
    return sendJson(res, 200, {
      status: true,
      tenantId,
      computerGroupKey,
      center: selection.center,
      updatedAt: selection.updatedAt,
    });
  }

  if (req.method === "POST" && pathname === "/api/center-selection") {
    try {
      const body = await readBody(req);
      const tenantId = safeSyncKey(body.tenantId || getTenantIdFromRequest(req, requestUrl));
      const computerGroupKey = centerSelectionComputerKey(body.computerGroupKey || requestUrl.searchParams.get("computer") || "");
      const center = String(body.center || "").trim();
      const tenant = getTenantState(tenantId);
      const selection = setCenterSelectionRecord(tenant, computerGroupKey, center);
      await persistSyncState();
      const broadcast = broadcastCenterSelectionToPeers({
        tenantId,
        computerGroupKey,
        center,
        commandId: body.commandId || "",
      });
      return sendJson(res, 200, { status: true, ...selection, ...broadcast });
    } catch (error) {
      return sendJson(res, 400, { status: false, message: error?.message || "Center selection sync failed" });
    }
  }

  if (req.method === "GET" && pathname === "/api/clients") {
    const tenantId = getTenantIdFromRequest(req, requestUrl);
    const tenant = getTenantState(tenantId);
    const includeDeleted = requestUrl.searchParams.get("includeDeleted") === "1";
    const clients = includeDeleted ? tenant.clients : tenant.clients.filter((c) => !c.deletedAt);
    return sendJson(res, 200, { status: true, clients, result: { list: clients } });
  }

  if (req.method === "POST" && pathname === "/api/clients") {
    try {
      const tenantId = getTenantIdFromRequest(req, requestUrl);
      const tenant = getTenantState(tenantId);
      const body = await readBody(req);
      const saved = upsertServerClient(tenant, body || {});
      tenant.updatedAt = new Date().toISOString();
      await persistSyncState();
      return sendJson(res, 200, { status: true, client: saved, result: { client: saved } });
    } catch (error) {
      return sendJson(res, 400, { status: false, message: error.message || "Invalid client payload" });
    }
  }

  if (req.method === "POST" && pathname === "/api/clients/surname") {
    try {
      const tenantId = getTenantIdFromRequest(req, requestUrl);
      const tenant = getTenantState(tenantId);
      const body = await readBody(req);
      const saved = updateServerClientSurname(tenant, body.id || body.clientId, body.surname);
      tenant.updatedAt = new Date().toISOString();
      await persistSyncState();
      return sendJson(res, 200, { status: true, client: saved, result: { client: saved } });
    } catch (error) {
      const status = /not found/i.test(String(error?.message || "")) ? 404 : 400;
      return sendJson(res, status, { status: false, message: error.message || "Invalid surname payload" });
    }
  }

  if (req.method === "POST" && pathname === "/api/clients/bulk-upsert") {
    try {
      const tenantId = getTenantIdFromRequest(req, requestUrl);
      const tenant = getTenantState(tenantId);
      const body = await readBody(req);
      const input = Array.isArray(body.clients) ? body.clients : [];
      const saved = input.map((client) => upsertServerClient(tenant, client));
      tenant.updatedAt = new Date().toISOString();
      await persistSyncState();
      return sendJson(res, 200, { status: true, clients: saved, result: { list: saved } });
    } catch (error) {
      return sendJson(res, 400, { status: false, message: error.message || "Invalid bulk payload" });
    }
  }

  if (req.method === "POST" && pathname === "/api/clients/delete") {
    try {
      const tenantId = getTenantIdFromRequest(req, requestUrl);
      const tenant = getTenantState(tenantId);
      const body = await readBody(req);
      const ids = deleteServerClients(tenant, body.ids || []);
      tenant.updatedAt = new Date().toISOString();
      await persistSyncState();
      return sendJson(res, 200, { status: true, ids });
    } catch (error) {
      return sendJson(res, 400, { status: false, message: error.message || "Invalid delete payload" });
    }
  }

  if (req.method === "GET" && pathname === "/api/proxies") {
    const tenantId = getTenantIdFromRequest(req, requestUrl);
    const tenant = getTenantState(tenantId);
    return sendJson(res, 200, { status: true, proxies: tenant.proxies });
  }

  if (req.method === "POST" && pathname === "/api/proxies/bulk-replace") {
    try {
      const tenantId = getTenantIdFromRequest(req, requestUrl);
      const tenant = getTenantState(tenantId);
      const body = await readBody(req);
      tenant.proxies = Array.isArray(body.proxies) ? body.proxies : [];
      tenant.updatedAt = new Date().toISOString();
      await persistSyncState();
      return sendJson(res, 200, { status: true, proxies: tenant.proxies });
    } catch (error) {
      return sendJson(res, 400, { status: false, message: error.message || "Invalid proxies payload" });
    }
  }

  if (req.method === "GET" && (req.url === "/health" || req.url === "/ping")) {
    return sendJson(res, 200, {
      ok: true,
      service: "sghir-local-bls-server",
      mode: "local-onnx-number-grid",
      host: HOST,
      port: PORT,
      debugSaving: false,
      modelConfigured: Boolean(_onnxSession),
      modelLoading: Boolean(_onnxSessionPromise),
      modelPath: MODEL_PATH,
      requireAccessToken: REQUIRE_ACCESS_TOKEN,
      stability: {
        maxConcurrentProviderRequests: MAX_CONCURRENT_PROVIDER_REQUESTS,
        semanticRetryMax: SEMANTIC_RETRY_MAX,
        semanticRetryDelayMs: SEMANTIC_RETRY_DELAY_MS
      },
      queue: getQueueStatus(),
      circuit: getCircuitStatus(),
      time: new Date().toISOString()
    });
  }

  if (req.method === "GET" && req.url === "/time") {
    return sendJson(res, 200, { ok: true, now: Date.now(), iso: new Date().toISOString() });
  }

  if (req.method === "GET" && req.url === "/ip") {
    return sendJson(res, 200, { ok: true, ip: getLocalIp(), localhost: "127.0.0.1" });
  }

  if (req.method === "POST" && req.url === "/api/predict") {
    const totalStartedAt = performance.now();
    const timings = {
      readBodyMs: 0,
      extractPayloadMs: 0,
      imageInfoMs: 0,
      debugSaveMs: 0,
      localInferenceMs: 0,
      extractAnswersMs: 0,
      selectionMs: 0,
      semanticRetryMs: 0,
      totalMs: 0
    };

    try {
      let stepStartedAt = performance.now();
      const body = await readBody(req);
      timings.readBodyMs = elapsedMs(stepStartedAt);

      stepStartedAt = performance.now();
      const pageType = body.pageType || body.type || "unknown";
      const pageUrl = body.url || body.pageUrl || body.websiteURL || "";
      const challenge = body.challenge || body.comment || body.question || "";
      const targetNumber = String(body.targetNumber || body.target || extractTargetNumber(challenge) || "").trim();
      const images = extractImages(body).filter(Boolean);
      const ids = extractIds(body).filter(Boolean);
      timings.extractPayloadMs = elapsedMs(stepStartedAt);

      if (!images.length) {
        timings.totalMs = elapsedMs(totalStartedAt);
        return sendJson(res, 400, {
          ok: false,
          error: "No images received",
          retryable: false,
          receivedImages: 0,
          receivedIds: ids.length,
          ids,
          queue: getQueueStatus(),
          circuit: getCircuitStatus(),
          timings
        });
      }

      stepStartedAt = performance.now();
      const imageInfos = images.map((image, index) => getImageInfo(image, index, ids[index]));
      timings.imageInfoMs = elapsedMs(stepStartedAt);

      const savedImages = [];
      timings.debugSaveMs = 0;

      stepStartedAt = performance.now();
      const localResult = await solveNumberGridLocal(images, pageUrl, challenge);
      timings.localInferenceMs = elapsedMs(stepStartedAt);

      stepStartedAt = performance.now();
      const answers = extractAnswers(localResult);
      timings.extractAnswersMs = elapsedMs(stepStartedAt);

      stepStartedAt = performance.now();
      let { selectedIndices, selectedIds, selectedTexts } = buildSelectionResult(answers, targetNumber, ids);
      timings.selectionMs = elapsedMs(stepStartedAt);

      // ── Semantic Retry ────────────────────────────────────────────────────
      // When a target exists but the provider returned no matching tile,
      // re-submit the same images up to SEMANTIC_RETRY_MAX times hoping
      // a fresh inference yields an answer that matches.
      let semanticAttempts = 0;
      let finalAnswers = answers;
      let finalLocalResult = localResult;

      if (targetNumber && selectedIndices.length === 0 && SEMANTIC_RETRY_MAX > 0) {
        const semanticStart = performance.now();

        while (selectedIndices.length === 0 && semanticAttempts < SEMANTIC_RETRY_MAX) {
          semanticAttempts += 1;

          if (!SILENT_LOG) {
            console.log(
              `[${new Date().toLocaleTimeString()}] Semantic retry ${semanticAttempts}/${SEMANTIC_RETRY_MAX} | target=${targetNumber} | prev_answers=${JSON.stringify(finalAnswers)}`
            );
          }

          if (SEMANTIC_RETRY_DELAY_MS > 0) await sleep(SEMANTIC_RETRY_DELAY_MS);

          const retryResult = await solveNumberGridLocal(images, pageUrl, challenge);
          const retryAnswers = extractAnswers(retryResult);
          const retrySelection = buildSelectionResult(retryAnswers, targetNumber, ids);

          if (!SILENT_LOG) {
            console.log(
              `[${new Date().toLocaleTimeString()}] Semantic retry ${semanticAttempts} result | answers=${JSON.stringify(retryAnswers)} | selected=${retrySelection.selectedIndices.length}`
            );
          }

          // Always update to latest attempt; stop early if a match was found.
          finalLocalResult = retryResult;
          finalAnswers = retryAnswers;
          selectedIndices = retrySelection.selectedIndices;
          selectedIds = retrySelection.selectedIds;
          selectedTexts = retrySelection.selectedTexts;
        }

        timings.semanticRetryMs = elapsedMs(semanticStart);
      }
      // ─────────────────────────────────────────────────────────────────────

      timings.totalMs = elapsedMs(totalStartedAt);

      printRequestLog({
        mode: "local-onnx-number-grid",
        pageType,
        pageUrl,
        challenge,
        targetNumber,
        images,
        ids,
        imageInfos,
        savedImages,
        accessTokenExists: Boolean(req.headers["x-access-token"]),
        elapsed: timings.totalMs,
        timings,
        answers: finalAnswers,
        selectedIndices,
        selectedIds,
        semanticAttempts
      });

      return sendJson(res, 200, {
        ok: true,
        mode: "local-onnx-number-grid",
        message: "Captcha images solved with local ONNX model.",
        providerModule: "local-onnx-model",
        pageType,
        pageUrl,
        challenge,
        targetNumber,
        receivedImages: images.length,
        receivedIds: ids.length,
        ids,
        imageInfos,
        debugSaving: false,
        savedImages,
        solvedInMs: timings.totalMs,
        timings,
        queue: getQueueStatus(),
        circuit: getCircuitStatus(),
        selectedIndices,
        selectedIds,
        selectedTexts,
        semanticRetry: {
          enabled: SEMANTIC_RETRY_MAX > 0,
          maxAttempts: SEMANTIC_RETRY_MAX,
          attempts: semanticAttempts,
          triggered: semanticAttempts > 0,
          resolvedMatch: semanticAttempts > 0 && selectedIndices.length > 0
        },
        warnings: {
          missingTargetNumber: !targetNumber,
          missingIds: ids.length === 0,
          noMatchFound: Boolean(targetNumber) && selectedIndices.length === 0
        },
        solution: {
          text: finalAnswers,
          apiIds: finalLocalResult.taskId ? [finalLocalResult.taskId] : [],
          raw: finalLocalResult,
          errors: []
        }
      });
    } catch (error) {
      timings.totalMs = elapsedMs(totalStartedAt);
      const publicError = getPublicError(error);
      if (!SILENT_LOG) {
        console.error(
          `[${new Date().toLocaleTimeString()}] /api/predict error | ${publicError.providerCode || "ERROR"} | ${publicError.message || publicError.error}`
        );
        if (VERBOSE_LOG) console.error("Timings before error:", timings);
      }
      const httpStatus = publicError.retryable ? 503 : 400;
      return sendJson(res, httpStatus, {
        ok: false,
        ...publicError,
        timings,
        queue: getQueueStatus(),
        circuit: getCircuitStatus()
      });
    }
  }

  return sendJson(res, 404, { ok: false, error: "Not found" });
});


server.on("upgrade", (req, socket) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

    // ── Signal WebSocket at "/" and "/ws" (extension cross-tab signals) ──
    // Ports the Python server's root_handler / websocket_handler. Handles
    // massSubmit/changeProxyAll/distributeGuessTime/seqSeconds/bypassBreach...
    if (requestUrl.pathname === "/" || requestUrl.pathname === "/ws") {
      if (signalWs.handleSignalUpgrade(req, socket)) return;
      // Not a valid signal/relay WS upgrade → fall through to destroy below.
    }

    if (requestUrl.pathname !== "/api/ws") return socket.destroy();
    const key = req.headers["sec-websocket-key"];
    const upgrade = String(req.headers.upgrade || "").toLowerCase();
    if (!key || upgrade !== "websocket") return socket.destroy();

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

    const meta = {
      tenantId: safeSyncKey(requestUrl.searchParams.get("tenant")),
      deviceId: String(requestUrl.searchParams.get("device") || ""),
      computerGroupKey: String(requestUrl.searchParams.get("computer") || ""),
      role: String(requestUrl.searchParams.get("role") || ""),
      profileId: String(requestUrl.searchParams.get("profile") || "").trim(),
      instanceId: String(requestUrl.searchParams.get("instance") || ""),
      lastSeenAt: Date.now(),
      buffer: Buffer.alloc(0),
      fragments: null,
    };
    wsPeers.set(socket, meta);
    wsSendJson(socket, { type: "welcome", local: true, time: Date.now() });

    socket.on("data", (chunk) => {
      const current = wsPeers.get(socket);
      if (!current) return;
      current.buffer = Buffer.concat([current.buffer || Buffer.alloc(0), chunk]);
      if (current.buffer.length > MAX_WS_MESSAGE_BYTES + 65536) return socket.destroy();
      processWsBuffer(socket);
    });
    const cleanup = () => wsPeers.delete(socket);
    socket.on("close", cleanup);
    socket.on("end", cleanup);
    socket.on("error", cleanup);
  } catch (_) {
    try { socket.destroy(); } catch (_) {}
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Mongoose LOCAL server running on http://${HOST}:${PORT}`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);
  console.log(`Local sync health: http://${HOST}:${PORT}/api/health`);
  console.log("Local sync data: existing persistent storage (preserved)");
  console.log("Clients + Proxies + Center Selection + ALL WebSocket: LOCAL ONLY (Fly sync disabled)");
  console.log("Signal WebSocket: ws://localhost:" + PORT + "/  (cross-tab signals: massSubmit/changeProxyAll/distributeGuessTime/seqSeconds/bypassBreach)");
  console.log("Debug image saving: disabled");
  console.log(`Server log level: ${SERVER_LOG_LEVEL}`);
  console.log(`Local ONNX model path: ${MODEL_PATH}`);
  console.log(`Access token required: ${REQUIRE_ACCESS_TOKEN}`);
  console.log(`Stable mode: queue=${MAX_CONCURRENT_PROVIDER_REQUESTS}, semanticRetry=${SEMANTIC_RETRY_MAX}/${SEMANTIC_RETRY_DELAY_MS}ms`);
  console.log(`Semantic retry: max=${SEMANTIC_RETRY_MAX}, delay=${SEMANTIC_RETRY_DELAY_MS}ms (triggers when target exists but selected=0)`);
  console.log("Leave this window open while testing.");
});

process.on("SIGINT", () => {
  console.log("\nStopping server...");
  server.close(() => {
    console.log("Server stopped.");
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});


module.exports = { server, ready: getOnnxSession };
