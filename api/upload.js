const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const EDITOR_PASSWORD = process.env.EDITOR_PASSWORD || 'editor2025';

async function ghGet(repo, path) {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
  });
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status}`);
  return res.json();
}

async function loadSiteConfig(siteId) {
  const fs = require('fs');
  const path = require('path');
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'sites', `${siteId}.json`), 'utf-8'));
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password, siteId = 'guardian', filename, contentBase64, mimeType } = req.body || {};

  if (password !== EDITOR_PASSWORD) return res.status(401).json({ error: 'パスワードが違います' });
  if (!filename || !contentBase64) return res.status(400).json({ error: 'ファイルデータがありません' });
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN が設定されていません' });

  const siteConfig = await loadSiteConfig(siteId);
  const repo = siteConfig?.repo;
  if (!repo) return res.status(500).json({ error: 'サイト設定が見つかりません' });

  const isVideo = mimeType?.startsWith('video/');
  const uploadDir = isVideo ? 'videos' : 'images';
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${uploadDir}/${safeName}`;

  try {
    let sha;
    try { const ex = await ghGet(repo, path); sha = ex.sha; } catch {}

    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: `アップロード: ${safeName}`,
        content: contentBase64,
        ...(sha && { sha })
      })
    });

    if (!putRes.ok) {
      const err = await putRes.json();
      throw new Error(err.message || `GitHub PUT failed: ${putRes.status}`);
    }

    const fileUrl = `${siteConfig.url}/${path}`;
    return res.status(200).json({ success: true, path, url: fileUrl });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
