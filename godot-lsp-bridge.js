#!/usr/bin/env node

'use strict';

// ─── 说明 ─────────────────────────────────────────────────────────────────────
//
// 这个脚本被 opencode 以 stdio 模式启动。
// 它只做一件事：把 stdin/stdout 转发到 godot-lsp-daemon 的 TCP 端口。
//
// 使用前确保 daemon 已经在运行：
//   node godot-lsp-daemon.js --godot /Applications/Godot --project /path/to/project
//
// ─────────────────────────────────────────────────────────────────────────────

const net = require('net');
const fs  = require('fs');
const os  = require('os');

// ─── 参数 ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

let daemonHost = '127.0.0.1';
let daemonPort = 7006;
let logFile    = `${os.homedir()}/godot-lsp-bridge.log`;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--daemon-port' && args[i+1]) { daemonPort = parseInt(args[++i], 10); }
    if (args[i] === '--log'         && args[i+1]) { logFile     = args[++i]; }
    // 忽略旧参数 --godot / --port，保持向后兼容
    if (args[i] === '--godot' || args[i] === '--port') i++;
}

// ─── 日志 ────────────────────────────────────────────────────────────────────

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    process.stderr.write(line);
    fs.appendFileSync(logFile, line);
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

function main() {
    log(`Connecting to daemon ${daemonHost}:${daemonPort}`);

    const socket = new net.Socket();

    socket.connect(daemonPort, daemonHost, () => {
        log('Connected to daemon');

        // stdin → daemon（原始转发，daemon 负责解析和重写）
        process.stdin.resume();
        process.stdin.setEncoding(null);

        process.stdin.on('data', (chunk) => {
            socket.write(chunk);
        });

        process.stdin.on('end', () => {
            log('stdin closed');
            socket.destroy();
            process.exit(0);
        });

        process.stdin.on('error', (err) => {
            log(`stdin error: ${err.message}`);
            socket.destroy();
            process.exit(1);
        });
    });

    // daemon → stdout（原始转发）
    socket.on('data', (chunk) => {
        process.stdout.write(chunk);
    });

    socket.on('error', (err) => {
        log(`Socket error: ${err.message} — is daemon running?`);
        process.exit(1);
    });

    socket.on('close', () => {
        log('Daemon connection closed');
        process.exit(0);
    });

    process.on('SIGINT',  () => { socket.destroy(); process.exit(0); });
    process.on('SIGTERM', () => { socket.destroy(); process.exit(0); });
}

main();
