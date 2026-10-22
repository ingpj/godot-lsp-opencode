#!/usr/bin/env node

'use strict';

// ─── 说明 ─────────────────────────────────────────────────────────────────────
//
// 这个脚本被 opencode 以 stdio 模式启动。
// 它把 stdin/stdout 上的 LSP 消息转发到 godot-lsp-daemon 的 TCP 端口。
//
// 断线处理：
//   - daemon 断开或未启动时，bridge 不退出，按退避间隔自动重连。
//   - 断线时正在等待响应的请求，立即返回 error（initialize 除外，会重新排队）。
//   - 断线期间到达的新请求排队，最多等待 QUEUE_TIMEOUT_MS，超时返回 error。
//   - 断线期间的文档变更仍然记入本地文档状态（didOpen/didChange/didClose）。
//   - 重连后自动重放：initialize（响应被吞掉）→ initialized → 所有已打开文档的 didOpen，
//     然后发送排队的请求。
//   - stdin 关闭（opencode 结束该 LSP 进程）时才退出。
//
// ─────────────────────────────────────────────────────────────────────────────

const net = require('net');
const fs = require('fs');
const os = require('os');

// ─── 参数 ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

const daemonHost = '127.0.0.1';
let daemonPort = 7006;
let logFile = `${os.homedir()}/godot-lsp-bridge.log`;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--daemon-port' && args[i + 1]) { daemonPort = parseInt(args[++i], 10); }
    if (args[i] === '--log' && args[i + 1]) { logFile = args[++i]; }
    // 忽略旧参数 --godot / --port，保持向后兼容
    if (args[i] === '--godot' || args[i] === '--port') i++;
}

const QUEUE_TIMEOUT_MS = 10000;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5000;
const REPLAY_INIT_ID = '__bridge_replay_initialize__';

// ─── 日志 ────────────────────────────────────────────────────────────────────

function log(msg) {
    const line = `[${new Date().toLocaleString()}] ${msg}\n`;
    process.stderr.write(line);
    try { fs.appendFileSync(logFile, line); } catch (_) {}
}

// ─── LSP 帧 ──────────────────────────────────────────────────────────────────

function frame(obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

class LspFramer {
    constructor(onMessage) {
        this.buf = Buffer.alloc(0);
        this.onMessage = onMessage;
    }

    feed(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        while (true) {
            const headerEnd = this.buf.indexOf('\r\n\r\n');
            if (headerEnd === -1) break;
            const m = this.buf.slice(0, headerEnd).toString('ascii').match(/Content-Length:\s*(\d+)/i);
            if (!m) {
                log('WARN: frame without Content-Length, discarding buffer');
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
                msg = JSON.parse(body.toString('utf8'));
            } catch (err) {
                log(`ERROR: invalid JSON frame: ${err.message}`);
                continue;
            }
            if (msg && typeof msg === 'object') this.onMessage(msg);
        }
    }
}

// ─── 状态 ────────────────────────────────────────────────────────────────────

let socket = null;          // 当前到 daemon 的连接
let connected = false;
let connecting = false;
let reconnectTimer = null;
let retryDelay = RETRY_MIN_MS;

let initRequest = null;      // opencode 发来的 initialize 请求（用于重放）
let initializedNote = null;  // opencode 发来的 initialized 通知（用于重放）
let sessionReady = false;    // initialize 响应已经回给 opencode
let waitingReplay = false;   // 正在等待重放 initialize 的响应

const docs = new Map();      // uri -> { languageId, version, text }
const pending = new Map();   // id -> { method, msg }：已转发到 daemon、等待响应的请求
let queue = [];              // [{ msg, at }]：等待连接的请求

// ─── 输出到 opencode ─────────────────────────────────────────────────────────

function writeOut(obj) {
    process.stdout.write(frame(obj));
}

function sendError(id, message) {
    writeOut({ jsonrpc: '2.0', id, error: { code: -32603, message } });
}

// ─── 发往 daemon ─────────────────────────────────────────────────────────────

function sendToDaemon(obj) {
    if (!connected || !socket) return false;
    socket.write(frame(obj));
    return true;
}

// ─── 文档状态 ────────────────────────────────────────────────────────────────

function offsetOf(text, pos) {
    let i = 0;
    for (let line = 0; line < pos.line; line++) {
        const n = text.indexOf('\n', i);
        if (n < 0) return text.length;
        i = n + 1;
    }
    return Math.min(i + pos.character, text.length);
}

function applyChanges(doc, changes) {
    for (const c of changes || []) {
        if (!c.range) {
            doc.text = c.text;
        } else {
            const s = offsetOf(doc.text, c.range.start);
            const e = offsetOf(doc.text, c.range.end);
            doc.text = doc.text.slice(0, s) + c.text + doc.text.slice(e);
        }
    }
}

// ─── 请求队列 ────────────────────────────────────────────────────────────────

function forwardRequest(msg) {
    pending.set(msg.id, { method: msg.method, msg });
    sendToDaemon(msg);
}

function flushQueue() {
    while (queue.length && connected && !waitingReplay) {
        const { msg } = queue.shift();
        forwardRequest(msg);
    }
}

setInterval(() => {
    if (connected) return;
    const now = Date.now();
    queue = queue.filter((item) => {
        if (now - item.at < QUEUE_TIMEOUT_MS) return true;
        sendError(item.msg.id, 'Godot LSP daemon unavailable (timed out waiting for reconnect)');
        return false;
    });
}, 1000).unref();

// ─── 连接管理 ────────────────────────────────────────────────────────────────

function scheduleReconnect() {
    if (reconnectTimer) return;
    log(`Reconnecting to daemon in ${retryDelay}ms`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
}

function failPending() {
    for (const [id, p] of pending) {
        if (p.method === 'initialize') {
            // initialize 未完成，重新排队，连上后再发
            queue.unshift({ msg: p.msg, at: Date.now() });
        } else {
            sendError(id, 'Godot LSP daemon disconnected');
        }
    }
    pending.clear();
}

function onDown(sock, reason) {
    if (sock.__down) return;
    sock.__down = true;
    if (socket === sock) {
        socket = null;
        connected = false;
        waitingReplay = false;
        log(`Daemon connection lost: ${reason}`);
        failPending();
    }
    connecting = false;
    scheduleReconnect();
}

function connect() {
    if (connecting || connected) return;
    connecting = true;
    const sock = new net.Socket();
    const framer = new LspFramer(onDaemonMessage);

    sock.connect(daemonPort, daemonHost, () => {
        socket = sock;
        connected = true;
        connecting = false;
        retryDelay = RETRY_MIN_MS;
        log('Connected to daemon');
        onConnected();
    });

    sock.on('data', (chunk) => framer.feed(chunk));
    sock.on('error', (err) => onDown(sock, err.message));
    sock.on('close', () => onDown(sock, 'closed'));
}

function onConnected() {
    if (sessionReady && initRequest) {
        // 重放 initialize，响应由 daemon 缓存返回，不转发给 opencode
        waitingReplay = true;
        sendToDaemon({ ...initRequest, id: REPLAY_INIT_ID });
        log('Replaying initialize');
        return;
    }
    flushQueue();
}

function finishReplay() {
    waitingReplay = false;
    if (initializedNote) sendToDaemon(initializedNote);
    for (const [uri, d] of docs) {
        sendToDaemon({
            jsonrpc: '2.0',
            method: 'textDocument/didOpen',
            params: { textDocument: { uri, languageId: d.languageId, version: d.version, text: d.text } },
        });
    }
    log(`Replay done: ${docs.size} open document(s)`);
    flushQueue();
}

// ─── daemon → opencode ───────────────────────────────────────────────────────

function onDaemonMessage(msg) {
    const hasId = msg.id !== undefined && msg.id !== null;

    // 响应
    if (msg.method === undefined && hasId) {
        if (msg.id === REPLAY_INIT_ID) return finishReplay();

        const p = pending.get(msg.id);
        if (!p) {
            log(`WARN: response for unknown id ${msg.id}, dropped`);
            return;
        }
        pending.delete(msg.id);
        if (p.method === 'initialize' && !msg.error) sessionReady = true;
        writeOut(msg);
        return;
    }

    // 通知或 server 请求，原样转发
    writeOut(msg);
}

// ─── opencode → daemon ───────────────────────────────────────────────────────

function onClientMessage(msg) {
    const hasId = msg.id !== undefined && msg.id !== null;
    // 方法级日志（不记录内容），用于判断 opencode 是否真的发出了请求
    log(`from opencode: ${msg.method ?? 'response'}${hasId ? ` id=${msg.id}` : ''}${msg.params?.textDocument?.uri ? ` ${msg.params.textDocument.uri}` : ''}`);

    // 对 server 请求的响应
    if (msg.method === undefined) {
        if (!sendToDaemon(msg)) log(`drop client response ${msg.id}: daemon not connected`);
        return;
    }

    // 请求
    if (hasId) {
        if (msg.method === 'initialize') initRequest = msg;
        if (connected && !waitingReplay) {
            forwardRequest(msg);
        } else {
            queue.push({ msg, at: Date.now() });
        }
        return;
    }

    // 通知
    const uri = msg.params?.textDocument?.uri;
    switch (msg.method) {
        case 'initialized':
            initializedNote = msg;
            break;
        case 'textDocument/didOpen': {
            const td = msg.params.textDocument;
            docs.set(td.uri, { languageId: td.languageId, version: td.version, text: td.text });
            break;
        }
        case 'textDocument/didChange': {
            const d = uri && docs.get(uri);
            if (d) {
                applyChanges(d, msg.params.contentChanges);
                d.version = msg.params.textDocument.version;
            }
            break;
        }
        case 'textDocument/didClose':
            if (uri) docs.delete(uri);
            break;
    }

    if (connected && !waitingReplay) {
        sendToDaemon(msg);
    } else if (msg.method !== 'initialized' && msg.method !== 'textDocument/didOpen' &&
               msg.method !== 'textDocument/didChange' && msg.method !== 'textDocument/didClose') {
        log(`drop notification ${msg.method}: daemon not connected`);
    }
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

function main() {
    log(`Bridge starting, daemon ${daemonHost}:${daemonPort}`);

    const clientFramer = new LspFramer((msg) => {
        // 对 opencode 消息的处理保持串行
        try {
            onClientMessage(msg);
        } catch (err) {
            log(`ERROR handling client message: ${err.stack || err.message}`);
        }
    });

    process.stdin.on('data', (chunk) => clientFramer.feed(chunk));

    process.stdin.on('end', () => {
        log('stdin closed');
        if (socket) socket.destroy();
        process.exit(0);
    });

    process.stdin.on('error', (err) => {
        log(`stdin error: ${err.message}`);
        if (socket) socket.destroy();
        process.exit(1);
    });

    process.on('SIGINT', () => { if (socket) socket.destroy(); process.exit(0); });
    process.on('SIGTERM', () => { if (socket) socket.destroy(); process.exit(0); });

    connect();
}

main();
