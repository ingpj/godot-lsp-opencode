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
// - textDocument/didOpen|didClose 按 uri 引用计数，只在首个打开/最后关闭时转发。
// - Godot 通知按 uri 路由到打开该文件的客户端，无 uri 的广播给所有客户端。

let godotSocket = null;
let godotConnecting = null;

let nextGodotId = 1;
let nextClientId = 1;
const clients = new Map(); // clientId -> { id, socket, openUris: Set<uri> }
const pending = new Map(); // godotId -> { clientId, origId, kind: "req" | "init" }
const openDocs = new Map(); // uri -> Set<clientId>
let godotInitResult = null;
let godotInitialized = false;
let initInFlight = false;
let initWaiters = []; // [{ clientId, origId }]

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
    try {
        await connectToGodot();
        return true;
    } catch (err) {
        log(`ERROR: cannot reach Godot: ${err.message}`);
        return false;
    }
}

// ─── Godot 连接管理 ──────────────────────────────────────────────────────────

// Godot 连接断开：通知所有等待中的客户端，并清空与该会话绑定的状态。
// 下次有请求时 ensureGodot 会重新连接，但 Godot 端的 LSP 会话是新的，
// 已连接的客户端需要重新 initialize（这是已知限制）。
function onGodotDown(sock) {
    if (godotSocket !== sock) return;
    godotSocket = null;
    log("Godot connection lost; resetting session state");

    for (const [gid, p] of pending) {
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
    openDocs.clear();
    for (const c of clients.values()) c.openUris.clear();
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

    // 通知：按 uri 路由，无法归属则广播
    const uri = msg.params?.uri;
    if (uri && openDocs.has(uri)) {
        for (const cid of openDocs.get(uri)) sendToClient(clients.get(cid), msg);
        return;
    }
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

    // 文档同步通知：didOpen / didClose 做引用计数
    const uri = msg.params?.textDocument?.uri;
    if (uri && msg.method === "textDocument/didOpen") {
        let set = openDocs.get(uri);
        if (!set) {
            set = new Set();
            openDocs.set(uri, set);
        }
        const first = set.size === 0;
        set.add(client.id);
        client.openUris.add(uri);
        if (!first) {
            log(`didOpen ${uri} already open; skipped for client #${client.id}`);
            return;
        }
    } else if (uri && msg.method === "textDocument/didClose") {
        const set = openDocs.get(uri);
        if (set) {
            set.delete(client.id);
            client.openUris.delete(uri);
            if (set.size > 0) return;
            openDocs.delete(uri);
        }
    }

    if (await ensureGodot()) sendToGodot(msg);
}

function removeClient(client) {
    if (!clients.has(client.id)) return;
    clients.delete(client.id);
    log(`Bridge client #${client.id} disconnected`);

    for (const uri of client.openUris) {
        const set = openDocs.get(uri);
        if (!set) continue;
        set.delete(client.id);
        if (set.size === 0) {
            openDocs.delete(uri);
            sendToGodot({
                jsonrpc: "2.0",
                method: "textDocument/didClose",
                params: { textDocument: { uri } },
            });
        }
    }
    client.openUris.clear();
    initWaiters = initWaiters.filter((w) => w.clientId !== client.id);
}

// ─── Bridge client 处理 ──────────────────────────────────────────────────────

function handleBridgeClient(socket) {
    const client = { id: nextClientId++, socket, openUris: new Set() };
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
