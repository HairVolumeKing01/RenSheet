// RenSheet 本地静态服务器（零依赖）
//
//   node serve.mjs            # 默认 http://localhost:8000
//   node serve.mjs 8080       # 指定端口
//
// 为什么需要它：ocr.html 的识别模型是 WASM，浏览器在 file:// 下会禁止
// 动态 import() 与 fetch()，双击打开必然报 “no available backend found”。
// 其他页面只用 <script src>，双击打开也能用。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 8000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".woff2": "font/woff2"
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(path.resolve(ROOT))) { res.writeHead(403).end("403"); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404 " + rel); return; }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": "no-cache"
    });
    fs.createReadStream(file).pipe(res);
  });
});

/** 本机所有可被手机访问的局域网地址（滤掉虚拟网卡 / 代理 / APIPA） */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  const isRealLan = (ip) =>
    (/^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip));
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (!isRealLan(info.address)) continue;   // 198.18.x（代理）、169.254.x（未连通）等一律不列
      out.push({ name, address: info.address });
    }
  }
  return out;
}

server.listen(PORT, "0.0.0.0", () => {
  const lan = lanAddresses();
  console.log("RenSheet 本地服务器已启动（Ctrl+C 停止）\n");
  console.log("电脑上打开：");
  console.log("  首页        http://localhost:" + PORT + "/index.html");
  console.log("  相册拼谷排表  http://localhost:" + PORT + "/ocr.html");
  console.log("  肾表        http://localhost:" + PORT + "/shenbiao.html");
  console.log("  国际表      http://localhost:" + PORT + "/guoji.html");
  console.log("  二调退补表   http://localhost:" + PORT + "/RatioFix.html");

  if (!lan.length) {
    console.log("\n没有检测到局域网地址（可能没连 Wi-Fi），手机暂时访问不了。");
    return;
  }
  console.log("\n手机上打开（需与电脑连同一个 Wi-Fi）：");
  lan.forEach((n) => {
    console.log("  " + n.name.padEnd(12) + " http://" + n.address + ":" + PORT + "/ocr.html");
  });
  console.log("\n如果手机打不开（一直转圈或拒绝连接）：Windows 防火墙拦了入站。");
  console.log("管理员 PowerShell 里放行一次（只需一次）：");
  console.log('  netsh advfirewall firewall add rule name="RenSheet Dev" dir=in action=allow protocol=TCP localport=' + PORT);
  console.log("用完想撤销：");
  console.log('  netsh advfirewall firewall delete rule name="RenSheet Dev"');
});
