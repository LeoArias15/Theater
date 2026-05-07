const https = require('https');

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: Object.assign({ 'User-Agent': 'Theater/1.0' }, headers || {})
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject).end();
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json'
};

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const imdbRaw = req.query.imdb_id || '';
  const apiUrl = `https://api.subdl.com/api/v1/subtitles?api_key=sZ44afVqvPnj_8gdxLVrk9Q9fBkVKTNQ&imdb_id=${imdbRaw}&languages=ES,EN&subs_per_page=20&comment=0`;
  try {
    const result = await httpsGet(apiUrl, { Accept: 'application/json' });
    const data = JSON.parse(result.body);
    const subs = (data.subtitles || []).slice(0, 15).map(s => ({
      name: s.release_name || s.name || 'Sub',
      lang: s.language || '',
      url: s.url ? 'https://dl.subdl.com' + s.url : ''
    }));
    res.status(200).json({ subtitles: subs });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
};
