const https = require('https');
const zlib = require('zlib');

function httpsGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': 'Theater/1.0' }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}

function extractSrtFromZip(buf) {
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i]===0x50&&buf[i+1]===0x4b&&buf[i+2]===0x05&&buf[i+3]===0x06) { eocdOffset=i; break; }
  }
  if (eocdOffset < 0) return null;
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdEntries = buf.readUInt16LE(eocdOffset + 8);
  let offset = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (buf[offset]!==0x50||buf[offset+1]!==0x4b) break;
    const fnLen = buf.readUInt16LE(offset+28), extraLen = buf.readUInt16LE(offset+30), commentLen = buf.readUInt16LE(offset+32);
    const localOffset = buf.readUInt32LE(offset+42);
    const fname = buf.slice(offset+46, offset+46+fnLen).toString('utf8');
    offset += 46 + fnLen + extraLen + commentLen;
    if (!fname.toLowerCase().endsWith('.srt')) continue;
    const lfnLen = buf.readUInt16LE(localOffset+26), lextraLen = buf.readUInt16LE(localOffset+28);
    const dataOffset = localOffset + 30 + lfnLen + lextraLen;
    const compSize = buf.readUInt32LE(localOffset+18), compMethod = buf.readUInt16LE(localOffset+8);
    const compData = buf.slice(dataOffset, dataOffset+compSize);
    if (compMethod === 0) return compData.toString('utf8');
    if (compMethod === 8) { try { return zlib.inflateRawSync(compData).toString('utf8'); } catch(e) { return null; } }
    return null;
  }
  return null;
}

function srtToVtt(srt) {
  const cleaned = srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return 'WEBVTT\n\n' + cleaned.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2').trim();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const zipUrl = req.query.url;
  if (!zipUrl || !zipUrl.includes('dl.subdl.com')) {
    res.status(400).send('invalid url'); return;
  }
  try {
    const result = await httpsGetBuffer(zipUrl);
    if (result.status !== 200) { res.status(502).send('subdl error ' + result.status); return; }
    const srt = extractSrtFromZip(result.buffer);
    if (!srt) { res.status(502).send('no srt found in zip'); return; }
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.status(200).send(srtToVtt(srt));
  } catch(e) {
    res.status(502).send('error: ' + e.message);
  }
};
