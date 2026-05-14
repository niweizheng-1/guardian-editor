const Anthropic = require('@anthropic-ai/sdk');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const EDITOR_PASSWORD = process.env.EDITOR_PASSWORD || 'editor2025';

// ── GitHub helpers ─────────────────────────────────────────

async function ghGet(repo, path) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
  });
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status} for ${path}`);
  return res.json();
}

async function ghPut(repo, path, content, message, sha) {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(content).toString('base64'),
      ...(sha && { sha })
    })
  });
  if (!res.ok) throw new Error(`GitHub PUT failed: ${res.status}`);
  return res.json();
}

// ── Site config loader ─────────────────────────────────────

async function loadSiteConfig(siteId) {
  const fs = require('fs');
  const path = require('path');
  const configPath = path.join(process.cwd(), 'sites', `${siteId}.json`);
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

function listSites() {
  const fs = require('fs');
  const path = require('path');
  const sitesDir = path.join(process.cwd(), 'sites');
  try {
    return fs.readdirSync(sitesDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const config = JSON.parse(fs.readFileSync(path.join(sitesDir, f), 'utf-8'));
        return { id: config.id, name: config.name, url: config.url };
      });
  } catch { return []; }
}

// ── Tool executor ──────────────────────────────────────────

async function executeTool(name, input, siteConfig) {
  const repo = siteConfig?.repo;

  switch (name) {
    case 'read_file': {
      try {
        const data = await ghGet(repo, input.path);
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        return { path: input.path, content: content.slice(0, 10000), sha: data.sha };
      } catch (e) { return { error: e.message }; }
    }

    case 'write_file': {
      try {
        let sha;
        try { const ex = await ghGet(repo, input.path); sha = ex.sha; } catch {}
        await ghPut(repo, input.path, input.content, input.message || `エディター: ${input.path}を更新`, sha);
        return { success: true, message: `✅ **${input.path}** を更新しました。約1分でサイトに反映されます。` };
      } catch (e) { return { error: e.message }; }
    }

    case 'list_files': {
      try {
        const data = await ghGet(repo, input.path || '');
        const files = Array.isArray(data)
          ? data.map(f => ({ name: f.name, type: f.type, path: f.path }))
          : [{ name: data.name, type: data.type, path: data.path }];
        return { files };
      } catch (e) { return { error: e.message }; }
    }

    case 'read_knowledge': {
      try {
        const kf = siteConfig?.knowledge_file || 'knowledge/fortune.json';
        const data = await ghGet(repo, kf);
        return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
      } catch (e) { return { error: e.message }; }
    }

    case 'update_knowledge': {
      try {
        const kf = siteConfig?.knowledge_file || 'knowledge/fortune.json';
        const existing = await ghGet(repo, kf);
        const current = JSON.parse(Buffer.from(existing.content, 'base64').toString('utf-8'));
        const merged = deepMerge(current, input.updates);
        await ghPut(repo, kf, JSON.stringify(merged, null, 2), input.message || '占い知識を更新', existing.sha);
        return { success: true, message: '✅ 占い知識データベースを更新しました。' };
      } catch (e) { return { error: e.message }; }
    }

    case 'get_site_info': {
      return {
        sites: listSites(),
        current: siteConfig ? { id: siteConfig.id, name: siteConfig.name, url: siteConfig.url, repo: siteConfig.repo } : null
      };
    }

    default: return { error: `不明なツール: ${name}` };
  }
}

function deepMerge(base, updates) {
  const result = { ...base };
  for (const key of Object.keys(updates)) {
    if (typeof updates[key] === 'object' && !Array.isArray(updates[key]) && result[key]) {
      result[key] = deepMerge(result[key], updates[key]);
    } else {
      result[key] = updates[key];
    }
  }
  return result;
}

// ── Tools ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'read_file',
    description: 'サイトのファイルを読み込む。編集前に必ず読む。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'ファイルパス（例: index.html, styles.css, guardian.js）' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'ファイルを更新してGitHubにpush。Vercelが自動でデプロイする。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'ファイルパス' },
        content: { type: 'string', description: '新しいファイルの全内容' },
        message: { type: 'string', description: 'コミットメッセージ（日本語OK）' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_files',
    description: 'リポジトリのファイル一覧を取得する。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'ディレクトリパス（省略可）' }
      }
    }
  },
  {
    name: 'read_knowledge',
    description: '占い知識データベース（五行、星座、数秘術、守護神ルールなど）を取得する。',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'update_knowledge',
    description: '占い知識データベースを追加・更新する。',
    input_schema: {
      type: 'object',
      properties: {
        updates: { type: 'object', description: '追加・更新するデータ' },
        message: { type: 'string', description: '更新内容の説明' }
      },
      required: ['updates']
    }
  },
  {
    name: 'get_site_info',
    description: '編集できるサイトの一覧と現在のサイト情報を取得する。',
    input_schema: { type: 'object', properties: {} }
  }
];

// ── System prompt builder ──────────────────────────────────

function buildSystemPrompt(siteConfig) {
  const site = siteConfig;
  return `あなたはウェブサイトを編集するAIエージェントです。
オーナーの日本語の指示を聞いて、サイトを自動で編集・デプロイします。

${site ? `【現在編集中のサイト】
- 名前: ${site.name}
- リポジトリ: ${site.repo}
- URL: ${site.url}
- 編集可能ファイル: ${site.editable_files?.join(', ')}
- 文章スタイル: ${JSON.stringify(site.style_guide)}` : '【サイト未選択】get_site_infoでサイト一覧を確認してください。'}

【行動ルール】
1. ファイルを編集する前に必ず read_file で現在の内容を確認する
2. 占い関係の編集は read_knowledge で知識を確認してから行う
3. 変更後は write_file で保存する（確認不要、自動保存でOK）
4. 完了後に何を変えたか日本語でわかりやすく報告する
5. エラーが出たらわかりやすく説明して解決策を提案する

【編集できること】
- テキスト・文章の変更 → 該当HTMLファイルを編集
- デザイン・色・レイアウト → styles.cssを編集
- 守護神の追加・変更 → guardian.jsのGUARDIAN_DBを編集
- 占い知識の追加 → update_knowledgeで知識DBを更新
- 新しいページ追加 → 新規HTMLファイルを作成

【文章を書くときの原則】
${site?.style_guide ? `- トーン: ${site.style_guide.tone}
- 避ける表現: ${site.style_guide.avoid?.join('、')}
- 推奨: ${site.style_guide.prefer?.join('、')}` : '- やさしく、共感的に。不安を煽らない。'}`;
}

// ── Main handler ───────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, history = [], password, siteId = 'guardian' } = req.body || {};

  if (password !== EDITOR_PASSWORD) return res.status(401).json({ error: 'パスワードが違います' });
  if (!message) return res.status(400).json({ error: 'メッセージがありません' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: '❌ ANTHROPIC_API_KEY が Vercel に設定されていません。Settings → Environment Variables を確認してください。' });

  const siteConfig = await loadSiteConfig(siteId);
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const systemPrompt = buildSystemPrompt(siteConfig);

  const messages = [
    ...history.slice(-12),
    { role: 'user', content: message }
  ];

  try {
    let response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8096,
      system: systemPrompt,
      tools: TOOLS,
      messages
    });

    const extraMessages = [];

    while (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const results = [];

      for (const tool of toolUses) {
        const result = await executeTool(tool.name, tool.input, siteConfig);
        results.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(result) });
      }

      extraMessages.push({ role: 'assistant', content: response.content });
      extraMessages.push({ role: 'user', content: results });

      response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8096,
        system: systemPrompt,
        tools: TOOLS,
        messages: [...messages, ...extraMessages]
      });
    }

    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

    return res.status(200).json({
      reply: text,
      history: [...history.slice(-12), { role: 'user', content: message }, { role: 'assistant', content: text }]
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
