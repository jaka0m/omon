#!/usr/bin/env node

const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const dgram = require('dgram');
const url = require('url');
const axios = require('axios');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ==================== PARSER CONFIG 'jokowi' TANPA TITIK ====================
// Kita buat parsing mandiri (pure JS) untuk file 'jokowi' agar tidak bergantung pada modul luar (seperti dotenv).
// Langkah ini menjamin environment port tetap aman dan tidak menimpa port Railway.
const jokowiPath = path.join(__dirname, 'jokowi');
if (fs.existsSync(jokowiPath)) {
  const jokowiContent = fs.readFileSync(jokowiPath, 'utf8');
  const lines = jokowiContent.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      const key = match[1];
      let val = match[2].trim();
      // Hilangkan tanda kutip pembungkus jika ada
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // Jangan menimpa port Railway jika PORT dikonfigurasi dinamis
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

// ==================== KONFIGURASI UTAMA ====================
const FILE_PATH = '.tmp';
const PORT = 8001; // Port internal Node.js gateway (ARGO_PORT)
const UUID = process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913';
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const CFIP = process.env.CFIP || 'bug.com';
const CFPORT = parseInt(process.env.CFPORT || '443', 10);
const NAME = process.env.NAME || 'JACK';

// SSH target port for the integrated SSH-over-WebSocket gateway
const SSH_TARGET = '127.0.0.1:22';

// ==================== GLOBAL CONSTANTS ====================
const horse = Buffer.from("dHJvamFu", 'base64').toString(); 
const flash = Buffer.from("dm1lc3M=", 'base64').toString(); 
const WS_READY_STATE_OPEN = 1;

let argoConfigs = { vless: '', vmess: '', trojan: '' };
const subFilePath = path.join(FILE_PATH, 'sub.txt');
const bootLogPath = path.join(FILE_PATH, 'boot.log');

if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

// --- Argo Tunnel Extract (if run anonymously) ---
async function startArgoMonitor() {
  if (ARGO_AUTH && ARGO_DOMAIN) {
    await generateLinks(ARGO_DOMAIN);
    return;
  }
  setTimeout(extractDomains, 5000);
}

async function extractDomains() {
  if (ARGO_AUTH && ARGO_DOMAIN) {
    await generateLinks(ARGO_DOMAIN);
    return;
  }
  try {
    if (fs.existsSync(bootLogPath)) {
      const logData = fs.readFileSync(bootLogPath, 'utf-8');
      const match = logData.match(/https?:\/\/([^ ]*trycloudflare\.com)\/?/);
      if (match) {
        console.log('[SYSTEM] Argo Tunnel Extracted:', match[1]);
        await generateLinks(match[1]);
        return;
      }
    }
  } catch (e) {}
  setTimeout(extractDomains, 3000);
}

async function generateLinks(domain) {
  const vmessObj = { v: '2', ps: `${NAME}-CDN-VMESS`, add: CFIP, port: CFPORT, id: UUID, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: domain, path: '/vmess', tls: 'tls', sni: domain, alpn: '', fp: 'firefox' };
  
  argoConfigs.vless = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${domain}&fp=firefox&type=ws&host=${domain}&path=%2Fvless-bubar#${NAME}-CDN-VLESS`;
  argoConfigs.vmess = `vmess://${Buffer.from(JSON.stringify(vmessObj)).toString('base64')}`;
  argoConfigs.trojan = `trojan://${UUID}@${CFIP}:${CFPORT}?security=tls&sni=${domain}&fp=firefox&type=ws&host=${domain}&path=%2Ftrojan-bubar#${NAME}-CDN-TROJAN`;
  
  const subTxt = `${argoConfigs.vless}\n${argoConfigs.vmess}\n${argoConfigs.trojan}`;
  fs.writeFileSync(subFilePath, subTxt);
  console.log('[SYSTEM] Argo Subscriptions generated successfully.');
}

// ==================== HYBRID GATEWAY SERVER ====================
class HybridServer {
  constructor() {
    this.wss = null;
    this.httpServer = null;
    this.activeUDPConnections = new Map();
    this.stats = { rx: 0, tx: 0 };
    this.lastCpu = null;
  }

  async handleHttpRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    
    // API Statistik (GLOBAL TRAFFIC + CPU + RAM)
    if (parsedUrl.pathname === '/api/stats') {
      let currentRx = this.stats.rx;
      let currentTx = this.stats.tx;

      // Baca Trafik Linux
      try {
        if (fs.existsSync('/proc/net/dev')) {
          const devData = fs.readFileSync('/proc/net/dev', 'utf-8');
          const lines = devData.split('\n');
          let sysRx = 0, sysTx = 0;
          for (let i = 2; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || line.startsWith('lo:')) continue; 
            const parts = line.split(/:?\s+/);
            if (parts.length > 9) {
              sysRx += parseInt(parts[1] || 0, 10);
              sysTx += parseInt(parts[9] || 0, 10);
            }
          }
          if (sysRx > 0 || sysTx > 0) { currentRx = sysRx; currentTx = sysTx; }
        }
      } catch (e) {}

      // Kalkulasi CPU
      const cpus = os.cpus();
      let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
      for (let cpu in cpus) {
        user += cpus[cpu].times.user; nice += cpus[cpu].times.nice;
        sys += cpus[cpu].times.sys; idle += cpus[cpu].times.idle;
        irq += cpus[cpu].times.irq;
      }
      const totalCpu = user + nice + sys + idle + irq;
      if (!this.lastCpu) this.lastCpu = { idle, total: totalCpu };
      const idleDelta = idle - this.lastCpu.idle;
      const totalDelta = totalCpu - this.lastCpu.total;
      const cpuUsage = totalDelta === 0 ? 0 : (100 - (100 * idleDelta / totalDelta)).toFixed(1);
      this.lastCpu = { idle, total: totalCpu };

      // Kalkulasi RAM
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const ramUsage = ((totalMem - freeMem) / totalMem * 100).toFixed(1);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        uptime: Math.floor(process.uptime()),
        rx: currentRx,
        tx: currentTx,
        cpu: parseFloat(cpuUsage),
        ram: parseFloat(ramUsage)
      }));
      return;
    }

    // API Config Terpusat
    if (parsedUrl.pathname === '/api/config') {
      const host = req.headers.host || '127.0.0.1';
      const payload = {
        native: {
          vless: `vless://${UUID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=firefox&type=ws&host=${host}&path=%2Fvless-bubar#${NAME}-SNI-VLESS`,
          trojan: `trojan://${UUID}@${host}:443?security=tls&sni=${host}&fp=firefox&type=ws&host=${host}&path=%2Ftrojan-bubar#${NAME}-SNI-TROJAN`
        },
        argo: {
          vless: argoConfigs.vless || 'Menunggu Cloudflare Argo Tunnel aktif...',
          vmess: argoConfigs.vmess || 'Menunggu Cloudflare Argo Tunnel aktif...',
          trojan: argoConfigs.trojan || 'Menunggu Cloudflare Argo Tunnel aktif...'
        }
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(payload));
    }

    // Dashboard UI Utama
    if (parsedUrl.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>GATEWAY CORE</title>
          <style>
            :root {
              --bg-black: #000000;
              --panel-bg: #0a0a0a;
              --card-bg: #050505;
              --border-color: #1f1f1f;
              --border-hover: #333333;
              --text-main: #ffffff;
              --text-muted: #888888;
              --accent-blue: #0088FF;
              --accent-cyan: #00ffff;
              --accent-purple: #a855f7;
              --accent-pink: #ff0080;
              --status-green: #00df89;
              --status-red: #ff5f56;
            }

            * { box-sizing: border-box; margin: 0; padding: 0; }

            body {
              background-color: var(--bg-black);
              color: var(--text-main);
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              min-height: 100vh;
              display: flex;
              flex-direction: column;
              align-items: center;
              padding: 6vh 24px;
            }

            .window-container {
              width: 100%;
              max-width: 680px;
              background-color: var(--panel-bg);
              border: 1px solid var(--border-color);
              border-radius: 12px;
              box-shadow: 0 30px 60px rgba(0, 0, 0, 0.8);
              overflow: hidden;
            }

            .window-header {
              background-color: var(--card-bg);
              border-bottom: 1px solid var(--border-color);
              padding: 14px 20px;
              display: flex;
              align-items: center;
              justify-content: space-between;
            }

            .mac-dots { display: flex; gap: 8px; }
            .dot { width: 12px; height: 12px; border-radius: 50%; opacity: 0.75; }
            .dot.close { background-color: #ff5f56; }
            .dot.minimize { background-color: #ffbd2e; }
            .dot.zoom { background-color: #27c93f; }

            .brand-title { font-size: 0.8rem; font-weight: 700; letter-spacing: 3px; text-transform: uppercase; }
            .brand-media { color: #ffffff; }
            .brand-fairy { color: var(--accent-blue); }

            .status-badge { display: flex; align-items: center; gap: 6px; font-size: 0.75rem; font-weight: 600; color: var(--status-green); }
            .pulse-dot {
              width: 6px; height: 6px; background-color: var(--status-green);
              border-radius: 50%; box-shadow: 0 0 8px var(--status-green);
              animation: ambientPulse 2.5s infinite ease-in-out;
            }

            .window-content { padding: 32px; }

            .uptime-section { text-align: center; padding-bottom: 24px; border-bottom: 1px solid var(--border-color); margin-bottom: 24px; }
            .section-label { font-size: 0.65rem; text-transform: uppercase; color: var(--text-muted); letter-spacing: 2px; margin-bottom: 6px; }
            .uptime-display { font-size: 2.5rem; font-weight: 800; letter-spacing: -1px; font-variant-numeric: tabular-nums; }

            /* 4 Columns Grid */
            .stats-grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 16px; margin-bottom: 24px; }
            .card { background-color: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; position: relative; overflow: hidden; }
            .card-value { font-size: 1.25rem; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
            .live-speed { font-size: 0.75rem; font-family: monospace; font-weight: 600; margin-top: 6px; }
            .live-speed.down { color: var(--status-green); }
            .live-speed.up { color: var(--accent-blue); }
            .resource-bar { width: 100%; height: 3px; background-color: #222; position: absolute; bottom: 0; left: 0; }
            .resource-fill { height: 100%; background-color: var(--accent-cyan); transition: width 1s ease; }

            /* Live Chart */
            .chart-card { background-color: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; margin-bottom: 32px; }
            .chart-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
            .legend { display: flex; gap: 12px; font-size: 0.7rem; color: var(--text-muted); font-weight: 600; }
            .legend-item { display: flex; align-items: center; gap: 4px; }
            .legend-color { width: 8px; height: 8px; border-radius: 50%; }
            .c-down { background-color: var(--status-green); box-shadow: 0 0 5px var(--status-green); }
            .c-up { background-color: var(--accent-blue); box-shadow: 0 0 5px var(--accent-blue); }
            .canvas-container { width: 100%; height: 120px; position: relative; }
            canvas { width: 100%; height: 100%; display: block; }

            .generator-section { background-color: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 20px; }
            .group-title { font-size: 0.75rem; font-weight: 600; color: var(--text-main); margin-bottom: 10px; border-left: 2px solid var(--border-hover); padding-left: 8px; }
            
            .btn-group-native { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
            .btn-group-argo { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 20px; }
            
            button { background-color: #111; color: #fff; border: 1px solid var(--border-color); padding: 10px; border-radius: 6px; font-size: 0.8rem; font-weight: 600; cursor: pointer; transition: all 0.2s ease; }
            button:hover { background-color: #222; border-color: #444; }
            button:active { transform: scale(0.98); }
            .btn-vless:hover { border-color: var(--accent-blue); color: var(--accent-blue); }
            .btn-vmess:hover { border-color: var(--accent-purple); color: var(--accent-purple); }
            .btn-trojan:hover { border-color: var(--accent-pink); color: var(--accent-pink); }

            .output-wrapper { display: flex; gap: 8px; margin-top: 10px; border-top: 1px solid var(--border-color); padding-top: 20px; }
            input[type="text"] { flex: 1; background-color: #000; border: 1px solid var(--border-color); color: var(--status-green); padding: 12px 16px; border-radius: 6px; font-family: monospace; font-size: 0.75rem; outline: none; }
            input[type="text"]:focus { border-color: var(--border-hover); color: var(--text-main); }
            .btn-copy { background-color: var(--text-main); color: var(--bg-black); padding: 0 20px; border: none; font-weight: 600; }
            .btn-copy:hover { background-color: #e0e0e0; }

            @media (max-width: 600px) {
              body { padding: 4vh 16px; }
              .stats-grid { grid-template-columns: 1fr 1fr; }
              .output-wrapper { flex-direction: column; }
              .btn-copy { padding: 12px; }
            }

            @keyframes ambientPulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
          </style>
        </head>
        <body>
          <div class="window-container">
            <div class="window-header">
              <div class="mac-dots"><div class="dot close"></div><div class="dot minimize"></div><div class="dot zoom"></div></div>
              <div class="brand-title"><span class="brand-media">JOKO</span><span class="brand-fairy">OMON</span></div>
              <div class="status-badge"><div class="pulse-dot"></div>RUNNING</div>
            </div>

            <div class="window-content">
              <div class="uptime-section">
                <div class="section-label">System Uptime</div>
                <div class="uptime-display" id="uptime-field">00:00:00</div>
              </div>
              
              <div class="stats-grid">
                <div class="card">
                  <div class="section-label">CPU</div>
                  <div class="card-value" id="cpu-val">0%</div>
                  <div class="resource-bar"><div class="resource-fill" id="cpu-bar" style="width:0%"></div></div>
                </div>
                <div class="card">
                  <div class="section-label">RAM</div>
                  <div class="card-value" id="ram-val">0%</div>
                  <div class="resource-bar"><div class="resource-fill" id="ram-bar" style="width:0%"></div></div>
                </div>
                <div class="card">
                  <div class="section-label">Download</div>
                  <div class="card-value" id="dl-total">0 B</div>
                  <div class="live-speed down" id="dl-speed">↓ 0 B/s</div>
                </div>
                <div class="card">
                  <div class="section-label">Upload</div>
                  <div class="card-value" id="ul-total">0 B</div>
                  <div class="live-speed up" id="ul-speed">↑ 0 B/s</div>
                </div>
              </div>

              <div class="chart-card">
                <div class="chart-header">
                  <div class="section-label" style="margin:0;">Network Traffic (60s)</div>
                  <div class="legend">
                    <div class="legend-item"><div class="legend-color c-down"></div>RX</div>
                    <div class="legend-item"><div class="legend-color c-up"></div>TX</div>
                  </div>
                </div>
                <div class="canvas-container">
                  <canvas id="trafficChart"></canvas>
                </div>
              </div>

              <div class="generator-section">
                <div class="group-title">⚡ BUG SNI</div>
                <div class="btn-group-native">
                  <button class="btn-vless" onclick="generate('native', 'vless')">VLESS</button>
                  <button class="btn-trojan" onclick="generate('native', 'trojan')">TROJAN</button>
                </div>
                <div class="group-title">🚀 BUG CDN</div>
                <div class="btn-group-argo">
                  <button class="btn-vless" onclick="generate('argo', 'vless')">VLESS</button>
                  <button class="btn-vmess" onclick="generate('argo', 'vmess')">VMESS</button>
                  <button class="btn-trojan" onclick="generate('argo', 'trojan')">TROJAN</button>
                </div>
                <div class="output-wrapper">
                  <input type="text" id="config-output" readonly placeholder="Pilih salah satu konfigurasi di atas..." />
                  <button class="btn-copy" id="copy-btn" onclick="copyConfig()">Copy</button>
                </div>
              </div>
            </div>
          </div>

          <script>
            function formatBytes(bytes) {
              if (bytes === 0) return '0 B'; const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.floor(Math.log(bytes) / Math.log(k));
              return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
            }
            function formatTime(ts) {
              const d = Math.floor(ts/86400), h = Math.floor((ts%86400)/3600), m = Math.floor((ts%3600)/60), s = ts%60;
              return (d>0?d+'d ':'') + String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
            }

            // Chart Configuration
            const canvas = document.getElementById('trafficChart');
            const ctx = canvas.getContext('2d');
            const maxPoints = 60;
            let rxHistory = new Array(maxPoints).fill(0);
            let txHistory = new Array(maxPoints).fill(0);
            let lastRx = 0, lastTx = 0, isFirstRender = true;

            function drawChart() {
              const rect = canvas.parentElement.getBoundingClientRect();
              canvas.width = rect.width * window.devicePixelRatio;
              canvas.height = rect.height * window.devicePixelRatio;
              ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
              
              const w = rect.width; const h = rect.height;
              ctx.clearRect(0, 0, w, h);

              // Grid lines
              ctx.strokeStyle = '#1f1f1f'; ctx.lineWidth = 1;
              ctx.beginPath(); ctx.moveTo(0, h/2); ctx.lineTo(w, h/2); ctx.stroke();
              ctx.beginPath(); ctx.moveTo(w/2, 0); ctx.lineTo(w/2, h); ctx.stroke();

              const maxVal = Math.max(...rxHistory, ...txHistory, 1024); // Minimal 1KB scale
              
              function renderLine(data, color, shadowColor) {
                ctx.beginPath();
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.shadowBlur = 12;
                ctx.shadowColor = shadowColor;
                
                for(let i=0; i<data.length; i++) {
                  const x = (i / (maxPoints - 1)) * w;
                  const y = h - ((data[i] / maxVal) * h * 0.9); // 10% padding top
                  if(i === 0) ctx.moveTo(x, y);
                  else ctx.lineTo(x, y);
                }
                ctx.stroke();
                ctx.shadowBlur = 0; // Reset
              }

              renderLine(rxHistory, '#00df89', 'rgba(0, 223, 137, 0.5)'); // Green RX
              renderLine(txHistory, '#0088FF', 'rgba(0, 136, 255, 0.5)'); // Blue TX
            }

            async function refreshDashboardStats() {
              try {
                const res = await fetch('/api/stats'); const data = await res.json();
                
                document.getElementById('uptime-field').innerText = formatTime(data.uptime);
                
                // Update CPU & RAM
                document.getElementById('cpu-val').innerText = data.cpu + '%';
                document.getElementById('cpu-bar').style.width = data.cpu + '%';
                document.getElementById('cpu-bar').style.backgroundColor = data.cpu > 80 ? 'var(--status-red)' : 'var(--accent-cyan)';
                
                document.getElementById('ram-val').innerText = data.ram + '%';
                document.getElementById('ram-bar').style.width = data.ram + '%';
                document.getElementById('ram-bar').style.backgroundColor = data.ram > 85 ? 'var(--status-red)' : 'var(--accent-purple)';

                // Calculate Speed
                let rxSpeed = 0, txSpeed = 0;
                if (!isFirstRender) {
                  rxSpeed = Math.max(0, data.rx - lastRx);
                  txSpeed = Math.max(0, data.tx - lastTx);
                }
                isFirstRender = false;
                lastRx = data.rx; lastTx = data.tx;

                // Update Text
                document.getElementById('dl-total').innerText = formatBytes(data.rx);
                document.getElementById('ul-total').innerText = formatBytes(data.tx);
                document.getElementById('dl-speed').innerText = '↓ ' + formatBytes(rxSpeed) + '/s';
                document.getElementById('ul-speed').innerText = '↑ ' + formatBytes(txSpeed) + '/s';

                // Update Chart
                rxHistory.push(rxSpeed); rxHistory.shift();
                txHistory.push(txSpeed); txHistory.shift();
                drawChart();

              } catch (e) {}
            }
            
            refreshDashboardStats(); setInterval(refreshDashboardStats, 1000);
            window.addEventListener('resize', drawChart);

            async function generate(network, protocol) {
              const outputEl = document.getElementById('config-output');
              outputEl.value = 'Loading...'; document.getElementById('copy-btn').innerText = 'Copy';
              try {
                const res = await fetch('/api/config'); const data = await res.json();
                outputEl.value = data[network][protocol];
              } catch (e) { outputEl.value = 'Gagal mengambil konfigurasi.'; }
            }

            function copyConfig() {
              const el = document.getElementById('config-output');
              if (!el.value || el.value.includes('Loading')) return; 
              el.select(); el.setSelectionRange(0, 99999);
              navigator.clipboard.writeText(el.value).then(() => {
                const btn = document.getElementById('copy-btn'); btn.innerText = 'Copied!';
                setTimeout(() => { if (btn.innerText === 'Copied!') btn.innerText = 'Copy'; }, 2000);
              });
            }
          </script>
        </body>
        </html>
      `);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found');
  }

  // ==================== WEBSOCKET HANDLERS ====================
  async handleWebSocketConnection(ws, request) {
    try {
      return await this.vlessVmessTrojanHandler(ws);
    } catch (err) {
      try { ws.close(1011, err.message); } catch (_) {}
    }
  }

  // VPN Protocol (VLESS, VMESS, TROJAN) WebSocket handler
  async vlessVmessTrojanHandler(ws) {
    let remoteSocketWrapper = { value: null };
    ws.on('message', async (message) => {
      try {
        const chunk = Buffer.from(message);
        this.stats.rx += chunk.length;
        if (remoteSocketWrapper.value) {
          return remoteSocketWrapper.value.write(chunk);
        }

        const protocol = await this.protocolSniffer(chunk);
        const protocolHeader = protocol === horse ? this.readHorseHeader(chunk) : this.readFlashHeader(chunk); 
        if (protocolHeader.hasError) throw new Error(protocolHeader.message);

        if (protocolHeader.isUDP) {
          return await this.handleUDPOutbound(protocolHeader.addressRemote, protocolHeader.portRemote, chunk.slice(protocolHeader.rawDataIndex), ws, protocolHeader.version);
        }
        this.handleTCPOutBound(remoteSocketWrapper, protocolHeader.addressRemote, protocolHeader.portRemote, protocolHeader.rawClientData, ws, protocolHeader.version);
      } catch (err) { ws.close(1011, err.message); }
    });

    ws.on('close', () => {
      if (remoteSocketWrapper.value) remoteSocketWrapper.value.end();
      this.cleanupUDPConnections(ws);
    });
    ws.on('error', () => this.cleanupUDPConnections(ws));
  }

  // High-performance raw SSH-over-WebSocket handler (dengan anti-reconnect & packet filtering)
  // Ini dipanggil langsung dari upgrade request, memotong framework `ws` library untuk meloloskan raw TCP stream
  async handleSSHUpgrade(socket, request) {
    // 1. Dapatkan Sec-WebSocket-Key untuk jabat tangan
    let wsKey = request.headers['sec-websocket-key'];
    if (!wsKey) {
      // Custom payloads (seperti di DarkTunnel) tidak mengirimkan header Sec-WebSocket-Key.
      // Kita buatkan random key agar jabat tangan WebSocket sukses & kompatibel dengan payload custom apapun.
      wsKey = Buffer.from(Math.random().toString() + Date.now().toString()).toString('base64');
    }

    const acceptKey = require('crypto')
      .createHash('sha1')
      .update(wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest('base64');

    let sshSocket;

    // Mencegah unhandled error crash pada raw client socket
    socket.on('error', (err) => {
      try { if (sshSocket) sshSocket.destroy(); } catch (_) {}
    });

    // 2. Kirim respon HTTP 101 Switching Protocols secara manual ke client socket
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + acceptKey + "\r\n\r\n"
    );

    // 3. Hubungkan ke SSH Daemon backend
    const [sshHost, sshPort] = SSH_TARGET.split(':');
    sshSocket = net.createConnection({ host: sshHost, port: parseInt(sshPort, 10) });

    sshSocket.on('error', () => {
      try { socket.destroy(); } catch (_) {}
    });

    let filtering = true;
    let totalRead = 0;

    socket.on('data', (chunk) => {
      try {
        this.stats.rx += chunk.length;

        if (filtering) {
          totalRead += chunk.length;
          // Cari banner SSH di dalam data stream saat ini
          const idx = chunk.indexOf(Buffer.from("SSH-"));
          if (idx !== -1) {
            const data = chunk.slice(idx);
            filtering = false; // Banner ketemu, matikan filter
            if (sshSocket.writable) sshSocket.write(data);
          } else if (totalRead > 4096) {
            // Bypass filter jika sudah melebihi 4KB (misal payload besar / speedtest upload)
            filtering = false;
            if (sshSocket.writable) sshSocket.write(chunk);
          } else {
            // Masih di bawah 4KB dan banner belum ketemu? Buang chunk sampah ini.
            return;
          }
        } else {
          if (sshSocket.writable) sshSocket.write(chunk);
        }
      } catch (err) {
        try { socket.destroy(); } catch (_) {}
      }
    });

    sshSocket.on('data', (chunk) => {
      this.stats.tx += chunk.length;
      if (socket.writable) {
        socket.write(chunk);
      }
    });

    socket.on('close', () => {
      try { sshSocket.destroy(); } catch (_) {}
    });

    sshSocket.on('close', () => {
      try { socket.destroy(); } catch (_) {}
    });
  }

  async protocolSniffer(buffer) {
    if (buffer.length >= 62) {
      const hd = buffer.slice(56, 60);
      if (hd[0] === 0x0d && hd[1] === 0x0a && [0x01, 0x03, 0x7f].includes(hd[2]) && [0x01, 0x03, 0x04].includes(hd[3])) return horse;
    }
    return flash; 
  }

  async handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader) {
    try {
      const tcpSocket = net.createConnection({ host: addressRemote, port: portRemote }, () => {
        tcpSocket.write(rawClientData);
      });
      remoteSocket.value = tcpSocket;
      tcpSocket.on('close', () => webSocket.close());
      tcpSocket.on('error', () => webSocket.close());
      
      let header = responseHeader;
      tcpSocket.on('data', (chunk) => {
        this.stats.tx += chunk.length;
        if (webSocket.readyState !== WS_READY_STATE_OPEN) return tcpSocket.destroy();
        if (header) {
          webSocket.send(Buffer.concat([Buffer.from(header), chunk]));
          header = null;
        } else {
          webSocket.send(chunk);
        }
      });
    } catch (error) { webSocket.close(); }
  }

  async handleUDPOutbound(targetAddress, targetPort, dataChunk, webSocket, responseHeader) {
    return new Promise((resolve) => {
      try {
        let header = responseHeader;
        const key = `${targetAddress}:${targetPort}:${Date.now()}`;
        const udpSocket = dgram.createSocket('udp4');
        
        this.activeUDPConnections.set(key, { socket: udpSocket, webSocket });
        udpSocket.on('error', () => {
          try { udpSocket.close(); } catch (_) {}
          this.activeUDPConnections.delete(key);
        });
        udpSocket.send(dataChunk, targetPort, targetAddress);
        
        udpSocket.on('message', (message) => {
          this.stats.tx += message.length;
          if (webSocket.readyState === WS_READY_STATE_OPEN) {
            if (header) {
              webSocket.send(Buffer.concat([Buffer.from(header), message]));
              header = null;
            } else {
              webSocket.send(message);
            }
          }
        });
        
        let timeout = setTimeout(() => {
          try { udpSocket.close(); } catch (_) {}
          this.activeUDPConnections.delete(key);
        }, 30000);

        udpSocket.on('message', () => {
          clearTimeout(timeout);
          timeout = setTimeout(() => {
            try { udpSocket.close(); } catch (_) {}
            this.activeUDPConnections.delete(key);
          }, 30000);
        });
      } catch (e) {}
    });
  }

  cleanupUDPConnections(webSocket) {
    for (const [key, conn] of this.activeUDPConnections.entries()) {
      if (conn.webSocket === webSocket) {
        try { conn.socket.close(); } catch (_) {}
        this.activeUDPConnections.delete(key);
      }
    }
  }

  readFlashHeader(buffer) {
    const v = buffer[0], optLen = buffer[17], cmd = buffer[18 + optLen], portIdx = 18 + optLen + 1;
    if (cmd !== 1 && cmd !== 2) return { hasError: true, message: "cmd unsupported" };
    const port = buffer.readUInt16BE(portIdx), addrType = buffer[portIdx + 2];
    let addrLen = 0, addrIdx = portIdx + 3, addr = "";
    
    if (addrType === 1) {
      addrLen = 4;
      addr = Array.from(buffer.slice(addrIdx, addrIdx + addrLen)).join(".");
    } else if (addrType === 2) {
      addrLen = buffer[addrIdx];
      addrIdx++;
      addr = buffer.slice(addrIdx, addrIdx + addrLen).toString();
    } else if (addrType === 3) {
      addrLen = 16;
      addr = Array.from({length: 8}, (_, i) => buffer.readUInt16BE(addrIdx + i*2).toString(16)).join(":");
    } else {
      return { hasError: true };
    }

    return {
      hasError: false,
      addressRemote: addr,
      portRemote: port,
      rawDataIndex: addrIdx + addrLen,
      rawClientData: buffer.slice(addrIdx + addrLen),
      version: Buffer.from([v, 0]),
      isUDP: cmd === 2
    };
  }

  readHorseHeader(buffer) {
    const data = buffer.slice(58);
    if (data.length < 6 || (data[0] !== 1 && data[0] !== 3)) return { hasError: true };
    const addrType = data[1];
    let addrLen = 0, addrIdx = 2, addr = "";
    
    if (addrType === 1) {
      addrLen = 4;
      addr = Array.from(data.slice(addrIdx, addrIdx + addrLen)).join(".");
    } else if (addrType === 3) {
      addrLen = data[addrIdx];
      addrIdx++;
      addr = data.slice(addrIdx, addrIdx + addrLen).toString();
    } else if (addrType === 4) {
      addrLen = 16;
      addr = Array.from({length: 8}, (_, i) => data.readUInt16BE(addrIdx + i*2).toString(16)).join(":");
    } else {
      return { hasError: true };
    }

    const portIdx = addrIdx + addrLen;
    return {
      hasError: false,
      addressRemote: addr,
      portRemote: data.readUInt16BE(portIdx),
      rawDataIndex: portIdx + 4,
      rawClientData: data.slice(portIdx + 4),
      version: null,
      isUDP: data[0] === 3
    };
  }

  start(port) {
    this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));
    this.wss = new WebSocket.Server({ noServer: true });

    // Intersep event 'upgrade' pada server HTTP secara manual untuk mengaktifkan websocket gateway
    this.httpServer.on('upgrade', (request, socket, head) => {
      const parsedPath = url.parse(request.url, true).pathname || '/';

      // Deteksi & Filter path VLESS, VMESS, TROJAN (baik standard maupun dengan akhiran -bubar)
      if (parsedPath === '/vless' || parsedPath === '/vless-bubar' ||
          parsedPath === '/vmess' || parsedPath === '/vmess-bubar' ||
          parsedPath === '/trojan' || parsedPath === '/trojan-bubar') {

        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request);
        });
      } else {
        // Jika path selain VLESS/VMESS/TROJAN, maka secara fleksibel ditingkatkan (upgraded) ke SSH raw-streaming
        this.handleSSHUpgrade(socket, request);
      }
    });

    this.wss.on('connection', (ws, req) => this.handleWebSocketConnection(ws, req));

    this.httpServer.listen(port, '0.0.0.0', () => {
      console.log(`[SYSTEM] Hybrid Gateway Active on Port ${port}`);
    });
  }
}

// ==================== BOOT SEQUENCE ====================
(async () => {
  console.log('[SYSTEM] Initializing Hybrid Core...');
  const server = new HybridServer();
  server.start(PORT);

  // Memulai monitor Cloudflare Argo
  startArgoMonitor().catch(err => console.error('[SYSTEM] Argo monitor error:', err));
})();
