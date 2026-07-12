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
        [
            "--editor",
            "--headless",
            "--lsp-port",
            String(godotPort),
            "--path",
            root,
        ],
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

// ─── Godot 连接管理 ──────────────────────────────────────────────────────────
//
// 只维持一条到 Godot 的 TCP 连接。
// 当前只支持一个活跃 client（Godot LSP 本身也只支持单客户端），
// 新 client 连入时会取代旧 client 接收 Godot 的响应。

let godotSocket = null;
let activeClient = null;
let godotConnecting = null;

function connectToGodot() {
    if (godotSocket && !godotSocket.destroyed) return Promise.resolve();
    if (godotConnecting) return godotConnecting;

    godotConnecting = new Promise((resolve, reject) => {
        const sock = new net.Socket();

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

        sock.on("data", (chunk) => {
            if (activeClient && !activeClient.destroyed) {
                activeClient.write(chunk);
            }
        });

        sock.on("error", (err) => {
            clearTimeout(timeout);
            log(`Godot socket error: ${err.message}`);
            godotSocket = null;
            godotConnecting = null;
            setTimeout(() => { connectToGodot(); }, 3000);
            reject(err);
        });

        sock.on("close", () => {
            clearTimeout(timeout);
            log("Godot socket closed, will reconnect in 3s");
            godotSocket = null;
            godotConnecting = null;
            setTimeout(() => { connectToGodot(); }, 3000);
            reject(new Error("Connection closed"));
        });
    });

    return godotConnecting;
}

// ─── LSP 消息重写 ─────────────────────────────────────────────────────────────

function rewriteIfNeeded(buf) {
    try {
        const json = JSON.parse(buf.toString("utf8"));
        if (json?.params?.textDocument?.languageId === "plaintext") {
            json.params.textDocument.languageId = "gdscript";
            log("rewrite: plaintext → gdscript");
            return Buffer.from(JSON.stringify(json), "utf8");
        }
    } catch (_) {}
    return buf;
}

function makeLspPacket(body) {
    const header = `Content-Length: ${body.length}\r\n\r\n`;
    return Buffer.concat([Buffer.from(header, "ascii"), body]);
}

// ─── Bridge client 处理 ──────────────────────────────────────────────────────
//
// 每个 bridge 连进来都是一个独立的 TCP socket（来自 opencode stdio bridge）。
// 我们解析它发来的 LSP 帧，重写后转发给 Godot。

function handleBridgeClient(client) {
    const addr = `${client.remoteAddress}:${client.remotePort}`;
    log(`Bridge client connected: ${addr}`);

    // 新 client 成为活跃接收方
    activeClient = client;

    let buf = Buffer.alloc(0);

    client.on("data", async (chunk) => {
        buf = Buffer.concat([buf, chunk]);

        while (true) {
            const headerEnd = buf.indexOf("\r\n\r\n");
            if (headerEnd === -1) break;

            const headerText = buf.slice(0, headerEnd).toString("ascii");
            const m = headerText.match(/Content-Length:\s*(\d+)/i);
            if (!m) {
                buf = Buffer.alloc(0);
                break;
            }

            const contentLength = parseInt(m[1], 10);
            const bodyStart = headerEnd + 4;
            const bodyEnd = bodyStart + contentLength;
            if (buf.length < bodyEnd) break;

            const body = buf.slice(bodyStart, bodyEnd);
            const rewritten = rewriteIfNeeded(body);
            const packet = makeLspPacket(rewritten);

            try {
                await connectToGodot();
                if (godotSocket && !godotSocket.destroyed) {
                    godotSocket.write(packet);
                }
            } catch (err) {
                log(`ERROR: cannot forward to Godot: ${err.message}`);
            }

            buf = buf.slice(bodyEnd);
        }
    });

    client.on("close", () => {
        log(`Bridge client disconnected: ${addr}`);
        if (activeClient === client) activeClient = null;
    });

    client.on("error", (err) => {
        log(`Bridge client error (${addr}): ${err.message}`);
    });
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
