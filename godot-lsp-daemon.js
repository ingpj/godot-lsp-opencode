#!/usr/bin/env node

"use strict";

const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// ─── 参数 ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

let godotHost = "127.0.0.1";
let godotPort = 6005; // Godot LSP 端口
let daemonPort = 7006; // daemon 自己监听的端口，bridge 连这里
let godotPath = "/Applications/Godot.app/Contents/MacOS/Godot";
let projectRoot = null; // 可手动指定，否则从 cwd 向上查找
let logFile = path.join(require("os").homedir(), "godot-lsp-daemon.log");
const GODOT_RECONNECT_MAX_ATTEMPTS = 10;
const GODOT_RECONNECT_INTERVAL_MS = 3000;

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--godot" && args[i + 1]) {
        godotPath = args[++i];
    }
    if (args[i] === "--godot-port" && args[i + 1]) {
        godotPort = parseInt(args[++i], 10);
    }
    if (args[i] === "--daemon-port" && args[i + 1]) {
        daemonPort = parseInt(args[++i], 10);
    }
    if (args[i] === "--project" && args[i + 1]) {
        projectRoot = args[++i];
    }
    if (args[i] === "--log" && args[i + 1]) {
        logFile = args[++i];
    }
}

// ─── 日志 ────────────────────────────────────────────────────────────────────

function log(msg) {
    const line = `[${new Date().toLocaleString()}] ${msg}\n`;
    process.stderr.write(line);
    fs.appendFileSync(logFile, line);
}

// ─── 工具 ────────────────────────────────────────────────────────────────────

function findProjectRoot(startDir) {
    let cur = startDir;
    for (let i = 0; i < 20; i++) {
        if (fs.existsSync(path.join(cur, "project.godot"))) return cur;
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }
    return null;
}

function makeLspPacket(body) {
    const header = `Content-Length: ${body.length}\r\n\r\n`;
    return Buffer.concat([Buffer.from(header, "ascii"), body]);
}

// 按 LSP 帧切分字节流，每得到一条完整消息就解析 JSON 并回调
class LspFramer {
    constructor(onMessage) {
        this.buf = Buffer.alloc(0);
        this.onMessage = onMessage;
    }

    feed(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        while (true) {
            const headerEnd = this.buf.indexOf("\r\n\r\n");
            if (headerEnd === -1) break;

            const m = this.buf.slice(0, headerEnd).toString("ascii").match(/Content-Length:\s*(\d+)/i);
            if (!m) {
                this.buf = Buffer.alloc(0);
                break;
            }

            const bodyStart = headerEnd + 4;
            const bodyEnd = bodyStart + parseInt(m[1], 10);
            if (this.buf.length < bodyEnd) break;

            const body = this.buf.slice(bodyStart, bodyEnd);
            this.buf = this.buf.slice(bodyEnd);

            let msg;
            try {
                msg = JSON.parse(body.toString("utf8"));
            } catch (err) {
                log(`ERROR: invalid JSON frame: ${err.message}`);
                continue;
            }
            if (msg && typeof msg === "object") this.onMessage(msg);
        }
    }
}

function sendPacket(sock, obj) {
    if (!sock || sock.destroyed) return false;
    sock.write(makeLspPacket(Buffer.from(JSON.stringify(obj), "utf8")));
    return true;
}

// ─── 全局状态 ────────────────────────────────────────────────────────────────
//
// 单条 Godot TCP 长连接，多个 bridge 客户端共享。
// - 请求 id 改写为 daemon 自增的 godotId，pending 记录原始 (clientId, origId)，
//   Godot 响应回来后还原 id 只发给对应客户端。
// - initialize 只真正发给 Godot 一次，结果缓存；之后的 initialize 直接返回缓存。
// - initialized 只转发一次；exit 不转发；shutdown 由 daemon 本地应答。
// - 只记录当前 Godot 会话的已打开 URI，以满足 didOpen/didChange/didClose 生命周期；
//   不缓存查询结果，也不在连接恢复时重放文档。

let godotSocket = null;
let godotConnecting = null;

let nextGodotId = 1;
let nextClientId = 1;
const clients = new Map(); // clientId -> { id, socket }
const pending = new Map(); // godotId -> { clientId, origId, kind: "req" | "init" }
let godotInitResult = null;
let godotInitialized = false;
let initInFlight = false;
let initWaiters = []; // [{ clientId, origId }]
let lastInitializeMsg = null;
let lastInitializedMsg = null;
let godotRecoveryPromise = null;
let godotRecoveryExhausted = false;
const openDocs = new Set(); // URI currently opened in this Godot TCP session

// 串行处理客户端消息，保证 initialize / didOpen 等顺序
let queue = Promise.resolve();
function enqueue(fn) {
    queue = queue
        .then(fn)
        .catch((err) => log(`ERROR: ${err.stack || err.message}`));
}

function sendToClient(client, obj) {
    if (!client || !clients.has(client.id)) return;
    sendPacket(client.socket, obj);
}

function sendToGodot(obj) {
    return sendPacket(godotSocket, obj);
}

function sendError(client, id, message) {
    sendToClient(client, { jsonrpc: "2.0", id, error: { code: -32603, message } });
}

// ─── Godot 启动 ──────────────────────────────────────────────────────────────

async function ensureGodotRunning() {
    try {
        await connectToGodot();
        log(`Godot LSP already running on ${godotPort}`);
        return;
    } catch (_) {}

    const root = projectRoot || findProjectRoot(process.cwd());
    if (!root) {
        log("ERROR: cannot find project.godot — pass --project <path>");
        process.exit(1);
    }

    log(`Launching Godot: ${godotPath}`);
    log(`Project root:    ${root}`);

    const child = spawn(
        godotPath,
        ["--editor", "--headless", "--lsp-port", String(godotPort), "--path", root],
        { detached: true, stdio: "ignore" },
    );
    child.unref();

    for (let i = 0; i < 40; i++) {
        try {
            await connectToGodot();
            log("Godot LSP ready");
            return;
        } catch (_) {
            await new Promise((r) => setTimeout(r, 500));
        }
    }

    log("ERROR: timed out waiting for Godot LSP");
    process.exit(1);
}

async function ensureGodot() {
    if (godotRecoveryPromise) return godotRecoveryPromise;
    if (godotRecoveryExhausted) return false;
    try {
        await connectToGodot();
        return true;
    } catch (err) {
        log(`ERROR: cannot reach Godot: ${err.message}`);
        return false;
    }
}

function initializeRecoveredGodotSession() {
    if (!lastInitializeMsg) return Promise.resolve();

    const id = nextGodotId++;
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            reject(new Error("Godot reinitialize timed out"));
        }, 10000);
        const reconnectInit = {
            kind: "reconnect-init",
            resolve: () => {
                clearTimeout(timeout);
                resolve();
            },
            reject: (err) => {
                clearTimeout(timeout);
                reject(err);
            },
        };
        pending.set(id, reconnectInit);
        if (!sendToGodot({ ...lastInitializeMsg, id })) {
            pending.delete(id);
            reconnectInit.reject(new Error("Godot socket unavailable during reinitialize"));
            return;
        }
        log("Reinitializing LSP session after Godot reconnect");
    });
}

async function reconnectGodotWithRetries() {
    for (let attempt = 1; attempt <= GODOT_RECONNECT_MAX_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, GODOT_RECONNECT_INTERVAL_MS));
        log(`Godot reconnect attempt ${attempt}/${GODOT_RECONNECT_MAX_ATTEMPTS}`);

        try {
            await connectToGodot();
            await initializeRecoveredGodotSession();
            godotRecoveryExhausted = false;
            log("Godot LSP reconnected and session restored");
            return true;
        } catch (err) {
            log(`Godot reconnect attempt ${attempt} failed: ${err.message}`);
            if (godotSocket && !godotSocket.destroyed) godotSocket.destroy();
        }
    }

    godotRecoveryExhausted = true;
    log(`Godot reconnect stopped after ${GODOT_RECONNECT_MAX_ATTEMPTS} attempts`);
    return false;
}

function startGodotReconnect() {
    if (godotRecoveryPromise) return;
    godotRecoveryExhausted = false;
    godotRecoveryPromise = reconnectGodotWithRetries().finally(() => {
        godotRecoveryPromise = null;
    });
}

// ─── Godot 连接管理 ──────────────────────────────────────────────────────────

// Godot 连接断开：通知等待中的客户端、清空会话状态，并启动后台重连。
function onGodotDown(sock) {
    if (godotSocket !== sock) return;
    godotSocket = null;
    openDocs.clear();
    log("Godot connection lost; resetting session state");

    for (const [gid, p] of pending) {
        if (p.kind === "reconnect-init") {
            pending.delete(gid);
            p.reject(new Error("Godot connection dropped during reinitialize"));
            continue;
        }
        sendError(clients.get(p.clientId), p.origId, "Godot LSP connection lost");
        pending.delete(gid);
    }
    for (const w of initWaiters) {
        sendError(clients.get(w.clientId), w.origId, "Godot LSP connection lost");
    }
    initWaiters = [];
    initInFlight = false;
    godotInitResult = null;
    godotInitialized = false;
    startGodotReconnect();
}

function connectToGodot() {
    if (godotSocket && !godotSocket.destroyed) return Promise.resolve();
    if (godotConnecting) return godotConnecting;

    godotConnecting = new Promise((resolve, reject) => {
        const sock = new net.Socket();
        const framer = new LspFramer(onGodotMessage);

        const timeout = setTimeout(() => {
            sock.destroy();
            godotConnecting = null;
            reject(new Error("Godot connection timed out"));
        }, 10000);

        sock.connect(godotPort, godotHost, () => {
            clearTimeout(timeout);
            log(`Connected to Godot LSP ${godotHost}:${godotPort}`);
            godotSocket = sock;
            godotConnecting = null;
            resolve();
        });

        sock.on("data", (chunk) => framer.feed(chunk));

        sock.on("error", (err) => {
            clearTimeout(timeout);
            log(`Godot socket error: ${err.message}`);
            onGodotDown(sock);
            godotConnecting = null;
            reject(err);
        });

        sock.on("close", () => {
            clearTimeout(timeout);
            log("Godot socket closed");
            onGodotDown(sock);
            godotConnecting = null;
            reject(new Error("Connection closed"));
        });
    });

    return godotConnecting;
}

// ─── Godot → 客户端 ──────────────────────────────────────────────────────────

function finishInit(p, msg) {
    initInFlight = false;
    if (msg.result !== undefined) godotInitResult = msg.result;

    const targets = [{ clientId: p.clientId, origId: p.origId }, ...initWaiters];
    initWaiters = [];
    for (const t of targets) {
        const client = clients.get(t.clientId);
        if (!client) continue;
        if (msg.error) {
            sendToClient(client, { jsonrpc: "2.0", id: t.origId, error: msg.error });
        } else {
            sendToClient(client, { jsonrpc: "2.0", id: t.origId, result: msg.result });
        }
    }
    log(`initialize completed; answered ${targets.length} client(s)`);
}

function onGodotMessage(msg) {
    const hasId = msg.id !== undefined && msg.id !== null;

    // 对 daemon 发出的请求的响应
    if (msg.method === undefined && hasId) {
        const p = pending.get(msg.id);
        if (!p) {
            log(`WARN: response for unknown id ${msg.id}`);
            return;
        }
        pending.delete(msg.id);
        if (p.kind === "reconnect-init") {
            if (msg.error) {
                p.reject(new Error(msg.error.message || "Godot reinitialize failed"));
                return;
            }
            godotInitResult = msg.result;
            if (lastInitializedMsg) sendToGodot(lastInitializedMsg);
            godotInitialized = true;
            p.resolve();
            log("Godot LSP initialize handshake restored");
            return;
        }
        if (p.kind === "init") return finishInit(p, msg);

        const client = clients.get(p.clientId);
        if (!client) {
            log(`drop response for id ${p.origId}: client gone`);
            return;
        }
        sendToClient(client, { ...msg, id: p.origId });
        return;
    }

    // Godot 发给客户端的请求（如 workspace/configuration）：交给最早连入的客户端，
    // 客户端的响应会原样转回 Godot
    if (msg.method !== undefined && hasId) {
        const client = clients.values().next().value;
        if (!client) {
            log(`WARN: server request ${msg.method} with no client`);
            return;
        }
        sendToClient(client, msg);
        return;
    }

    // 文档状态仅用于维护 Godot LSP 生命周期；Godot 通知广播给当前客户端。
    for (const c of clients.values()) sendToClient(c, msg);
}

// ─── 客户端 → Godot ──────────────────────────────────────────────────────────

function findGodotId(clientId, origId) {
    for (const [gid, p] of pending) {
        if (p.clientId === clientId && p.origId === origId) return gid;
    }
    return undefined;
}

async function handleInitialize(client, msg) {
    lastInitializeMsg = msg;
    if (godotInitResult) {
        sendToClient(client, { jsonrpc: "2.0", id: msg.id, result: godotInitResult });
        return;
    }
    if (initInFlight) {
        initWaiters.push({ clientId: client.id, origId: msg.id });
        return;
    }
    if (!(await ensureGodot())) {
        sendError(client, msg.id, "Godot LSP not connected");
        return;
    }
    if (godotInitResult) {
        sendToClient(client, { jsonrpc: "2.0", id: msg.id, result: godotInitResult });
        return;
    }
    initInFlight = true;
    const gid = nextGodotId++;
    pending.set(gid, { clientId: client.id, origId: msg.id, kind: "init" });
    log(`initialize forwarded for client #${client.id}`);
    sendToGodot({ ...msg, id: gid });
}

async function handleClientMessage(client, msg) {
    if (!clients.has(client.id)) return;

    // 重写 plaintext languageId
    if (msg?.params?.textDocument?.languageId === "plaintext") {
        msg.params.textDocument.languageId = "gdscript";
        log("rewrite: plaintext → gdscript");
    }

    const hasId = msg.id !== undefined && msg.id !== null;

    // 客户端对 Godot 请求的响应：原样转回
    if (msg.method === undefined) {
        if (await ensureGodot()) sendToGodot(msg);
        return;
    }

    if (msg.method === "initialize" && hasId) return handleInitialize(client, msg);

    if (msg.method === "shutdown" && hasId) {
        sendToClient(client, { jsonrpc: "2.0", id: msg.id, result: null });
        return;
    }

    if (msg.method === "exit") {
        // 单个 bridge 退出不能结束 daemon 与 Godot 的会话
        log(`exit from client #${client.id} ignored`);
        return;
    }

    if (msg.method === "initialized") {
        lastInitializedMsg = msg;
        if (!godotInitResult || godotInitialized) return;
        if (!(await ensureGodot())) return;
        godotInitialized = true;
        sendToGodot(msg);
        return;
    }

    if (msg.method === "$/cancelRequest") {
        const gid = findGodotId(client.id, msg.params?.id);
        if (gid !== undefined && (await ensureGodot())) {
            sendToGodot({ jsonrpc: "2.0", method: msg.method, params: { id: gid } });
        }
        return;
    }

    // Bridge 将每次同步都编码为 didOpen + 完整文本。
    // Godot 对同一 URI 的 didOpen 严格报错，因此在 daemon 侧按当前
    // Godot TCP 会话状态转换为 didOpen（首次）或全文 didChange（后续）。
    if (msg.method === "textDocument/didOpen") {
        const doc = msg.params?.textDocument;
        const uri = doc?.uri;
        if (!uri || typeof doc.text !== "string") {
            log(`WARN: invalid didOpen from client #${client.id}`);
            return;
        }
        if (!(await ensureGodot())) return;

        if (openDocs.has(uri)) {
            sendToGodot({
                jsonrpc: "2.0",
                method: "textDocument/didChange",
                params: {
                    textDocument: { uri, version: doc.version },
                    contentChanges: [{ text: doc.text }],
                },
            });
            log(`document sync didChange ${uri}`);
        } else {
            openDocs.add(uri);
            sendToGodot(msg);
            log(`document sync didOpen ${uri}`);
        }
        return;
    }

    if (msg.method === "textDocument/didClose") {
        const uri = msg.params?.textDocument?.uri;
        if (!uri || !openDocs.has(uri)) {
            log(`ignore didClose for unopened URI ${uri || "<missing>"}`);
            return;
        }
        openDocs.delete(uri);
        sendToGodot(msg);
        log(`document sync didClose ${uri}`);
        return;
    }

    if (hasId) {
        if (!(await ensureGodot())) {
            sendError(client, msg.id, "Godot LSP not connected");
            return;
        }
        const gid = nextGodotId++;
        pending.set(gid, { clientId: client.id, origId: msg.id, kind: "req" });
        sendToGodot({ ...msg, id: gid });
        return;
    }

    if (await ensureGodot()) sendToGodot(msg);
}

function removeClient(client) {
    if (!clients.has(client.id)) return;
    clients.delete(client.id);
    log(`Bridge client #${client.id} disconnected`);
    initWaiters = initWaiters.filter((w) => w.clientId !== client.id);
}

// ─── Bridge client 处理 ──────────────────────────────────────────────────────

function handleBridgeClient(socket) {
    const client = { id: nextClientId++, socket };
    clients.set(client.id, client);
    log(`Bridge client #${client.id} connected: ${socket.remoteAddress}:${socket.remotePort}`);

    const framer = new LspFramer((msg) => enqueue(() => handleClientMessage(client, msg)));
    socket.on("data", (chunk) => framer.feed(chunk));
    socket.on("close", () => enqueue(() => removeClient(client)));
    socket.on("error", (err) => log(`Bridge client #${client.id} error: ${err.message}`));
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
    log(`=== godot-lsp-daemon starting (daemon port: ${daemonPort}) ===`);

    await ensureGodotRunning();

    const server = net.createServer(handleBridgeClient);

    server.listen(daemonPort, "127.0.0.1", () => {
        log(`Daemon listening on 127.0.0.1:${daemonPort}`);
    });

    server.on("error", (err) => {
        log(`Server error: ${err.message}`);
        process.exit(1);
    });

    process.on("SIGINT", () => {
        log("SIGINT, exiting");
        process.exit(0);
    });
    process.on("SIGTERM", () => {
        log("SIGTERM, exiting");
        process.exit(0);
    });
}

main().catch((err) => {
    log(`Fatal: ${err.message}`);
    process.exit(1);
});

// run server
// node godot-lsp-daemon.js --godot /Applications/Godot.app/Contents/MacOS/Godot --project ~/Dev/Proj-A
