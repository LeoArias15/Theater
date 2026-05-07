const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

const PORT = 11480;
const STREMIO = { host: '127.0.0.1', port: 11470 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*'
};

function stremioGet(reqPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: STREMIO.host, port: STREMIO.port, path: reqPath }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

function httpsGetBuffer(targetUrl, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: Object.assign({ 'User-Agent': 'Theater/1.0' }, extraHeaders || {})
    };
    https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}

// SRT -> VTT converter
function srtToVtt(srt) {
  const cleaned = srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const converted = cleaned.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2').trim();
  return 'WEBVTT\n\n' + converted;
}

// Extraer primer .srt de un ZIP (implementacion minimal sin dependencias)
function extractSrtFromZip(buf) {
  // Buscar End of Central Directory
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x05 && buf[i+3] === 0x06) {
      eocdOffset = i; break;
    }
  }
  if (eocdOffset < 0) return null;
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdEntries = buf.readUInt16LE(eocdOffset + 8);
  let offset = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (buf[offset] !== 0x50 || buf[offset+1] !== 0x4b) break;
    const fnLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const fname = buf.slice(offset + 46, offset + 46 + fnLen).toString('utf8');
    offset += 46 + fnLen + extraLen + commentLen;
    if (!fname.toLowerCase().endsWith('.srt')) continue;
    // Leer local file header
    const lfnLen = buf.readUInt16LE(localOffset + 26);
    const lextraLen = buf.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + lfnLen + lextraLen;
    const compSize = buf.readUInt32LE(localOffset + 18);
    const compMethod = buf.readUInt16LE(localOffset + 8);
    const compData = buf.slice(dataOffset, dataOffset + compSize);
    if (compMethod === 0) return compData.toString('utf8');
    if (compMethod === 8) {
      try { return zlib.inflateRawSync(compData).toString('utf8'); } catch(e) { return null; }
    }
    return null;
  }
  return null;
}

function httpsGet(targetUrl, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: Object.assign({ 'User-Agent': 'Theater/1.0', 'Accept': 'application/json' }, extraHeaders || {})
    };
    https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject).end();
  });
}

http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (parsed.pathname === '/favicon.ico') {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#1a1f14"/><polygon points="35,25 75,50 35,75" fill="#6aaa52"/></svg>');
    res.writeHead(200, { ...CORS, 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public,max-age=86400' });
    res.end(svg);
    return;
  }

  if (parsed.pathname === '/' || parsed.pathname.toLowerCase().endsWith('.html')) {
    const file = path.join(__dirname, 'Theater.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, CORS); res.end('Not found'); return; }
      res.writeHead(200, { ...CORS, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (parsed.pathname === '/probe') {
    try {
      const mediaURL = parsed.query.mediaURL;
      const result = await stremioGet('/hlsv2/probe?mediaURL=' + encodeURIComponent(mediaURL));
      res.writeHead(result.status, { ...CORS, 'Content-Type': 'application/json' });
      res.end(result.body);
    } catch (e) {
      res.writeHead(502, CORS);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (parsed.pathname === '/subdl') {
    // Buscar subtitulos via Subscene/Subdl alternativo
    try {
      const qs = parsed.query || {};
      const imdbRaw = qs.imdb_id || '';
      // subdl.com requiere el formato tt sin prefijo numerico
      const apiUrl = `https://api.subdl.com/api/v1/subtitles?api_key=sZ44afVqvPnj_8gdxLVrk9Q9fBkVKTNQ&imdb_id=${imdbRaw}&languages=ES,EN&subs_per_page=20&comment=0`;
      const result = await httpsGet(apiUrl, { 'Accept': 'application/json', 'User-Agent': 'Theater/1.0' });
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      try {
        const data = JSON.parse(result.body);
        const subs = (data.subtitles || []).slice(0, 15).map(s => ({
          name: s.release_name || s.name || 'Sub',
          lang: s.language || '',
          url: s.url ? 'https://dl.subdl.com' + s.url : ''
        }));
        res.end(JSON.stringify({ subtitles: subs, status: data.status }));
      } catch(pe) {
        res.end(result.body);
      }
    } catch (e) {
      res.writeHead(502, CORS);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (parsed.pathname === '/opensubtitles') {
    try {
      const targetUrl = parsed.query.url;
      if (!targetUrl || !targetUrl.includes('opensubtitles')) {
        res.writeHead(400, CORS); res.end(JSON.stringify({ error: 'invalid url' })); return;
      }
      const result = await httpsGet(targetUrl, {
        'Api-Key': 'tryitout',
        'User-Agent': 'Theater v1.0',
        'Content-Type': 'application/json'
      });
      res.writeHead(result.status, { ...CORS, 'Content-Type': 'application/json' });
      res.end(result.body);
    } catch (e) {
      res.writeHead(502, CORS);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (parsed.pathname === '/subdl-vtt') {
    try {
      const zipUrl = parsed.query.url;
      if (!zipUrl || !zipUrl.includes('dl.subdl.com')) {
        res.writeHead(400, CORS); res.end('invalid url'); return;
      }
      const result = await httpsGetBuffer(zipUrl);
      if (result.status !== 200) {
        res.writeHead(502, CORS); res.end('subdl error ' + result.status); return;
      }
      const srt = extractSrtFromZip(result.buffer);
      if (!srt) {
        res.writeHead(502, CORS); res.end('no srt found in zip'); return;
      }
      const vtt = srtToVtt(srt);
      res.writeHead(200, { ...CORS, 'Content-Type': 'text/vtt; charset=utf-8' });
      res.end(vtt);
    } catch(e) {
      res.writeHead(502, CORS);
      res.end('error: ' + e.message);
    }
    return;
  }

  // Proxy a Stremio
  const options = {
    hostname: STREMIO.host,
    port: STREMIO.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: STREMIO.host + ':' + STREMIO.port, origin: 'http://' + STREMIO.host + ':' + STREMIO.port }
  };

  const proxy = http.request(options, stremioRes => {
    res.writeHead(stremioRes.statusCode, { ...stremioRes.headers, ...CORS });
    stremioRes.pipe(res, { end: true });
  });

  proxy.on('error', e => {
    if (!res.headersSent) { res.writeHead(502, CORS); res.end('Stremio error: ' + e.message); }
  });

  req.pipe(proxy, { end: true });

}).listen(PORT, () => {
  console.log('=================================');
  console.log('Theater: http://localhost:' + PORT + '/Theater.html');
  console.log('=================================');
});
