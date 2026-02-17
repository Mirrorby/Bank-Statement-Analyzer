/**
 * Google Apps Script для проверки Telegram-каналов из Google Sheets.
 *
 * Что делает:
 * 1) Берет ссылки из колонки A (начиная со 2 строки).
 * 2) Проходит по каждому каналу.
 * 3) Проверяет последние 30 постов (если доступны):
 *    - есть ли в посте хэштег #реклама
 *    - есть ли в том же посте ссылка на рекламодателя, начинающаяся с https://ya.cc
 * 4) Записывает результат в колонки B-I.
 *
 * Ограничения:
 * - Ссылки вида https://t.me/+... (invite/private) не читаются без авторизации.
 *   Для таких ссылок скрипт ставит статус INVITE_LINK_UNAVAILABLE.
 */

const MAX_POSTS_TO_CHECK = 30;
const REQUEST_TIMEOUT_MS = 15000;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Telegram Audit')
    .addItem('Проверить каналы', 'auditTelegramChannels')
    .addToUi();
}

function auditTelegramChannels() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const startRow = 2;
  const lastRow = sheet.getLastRow();

  if (lastRow < startRow) {
    SpreadsheetApp.getUi().alert('Нет данных для проверки. Добавьте ссылки в колонку A, начиная со 2 строки.');
    return;
  }

  ensureHeaders_(sheet);

  const rowCount = lastRow - startRow + 1;
  const values = sheet.getRange(startRow, 1, rowCount, 1).getValues();

  const output = [];

  for (let i = 0; i < values.length; i++) {
    const rawUrl = String(values[i][0] || '').trim();

    if (!rawUrl) {
      output.push(['EMPTY', 0, 0, 0, '', '', '', new Date()]);
      continue;
    }

    try {
      const parsed = parseTelegramUrl_(rawUrl);

      if (!parsed.ok) {
        output.push([
          parsed.status,
          0,
          0,
          0,
          '',
          '',
          parsed.error || 'Некорректная ссылка',
          new Date()
        ]);
        continue;
      }

      if (parsed.type === 'invite') {
        output.push([
          'INVITE_LINK_UNAVAILABLE',
          0,
          0,
          0,
          '',
          '',
          'Invite/private ссылка, публичный HTML недоступен без авторизации',
          new Date()
        ]);
        continue;
      }

      const posts = fetchLastPostsFromPublicChannel_(parsed.username, MAX_POSTS_TO_CHECK);
      const analysis = analyzePosts_(posts);

      output.push([
        'OK',
        analysis.checkedCount,
        analysis.hashtagCount,
        analysis.hashtagAndYaCcCount,
        analysis.hashtagPostIds.join(', '),
        analysis.hashtagAndYaCcPostIds.join(', '),
        analysis.note,
        new Date()
      ]);
    } catch (err) {
      output.push(['ERROR', 0, 0, 0, '', '', String(err), new Date()]);
    }

    Utilities.sleep(250);
  }

  sheet.getRange(startRow, 2, output.length, 8).setValues(output);
}

function ensureHeaders_(sheet) {
  const headers = [
    'status',
    'checked_posts',
    'posts_with_#реклама',
    'posts_with_#реклама_and_ya.cc',
    'post_ids_with_#реклама',
    'post_ids_with_#реклама_and_ya.cc',
    'note_or_error',
    'checked_at'
  ];
  sheet.getRange(1, 2, 1, headers.length).setValues([headers]);
}

function parseTelegramUrl_(url) {
  const cleaned = url.replace(/\\n/g, '').trim();
  const m = cleaned.match(/^https?:\/\/t\.me\/(.+)$/i);
  if (!m) return { ok: false, status: 'INVALID_URL', error: 'Ожидается ссылка вида https://t.me/...'};

  const path = m[1].replace(/\/$/, '');

  if (path.startsWith('+') || path.toLowerCase().startsWith('joinchat/')) {
    return { ok: true, type: 'invite' };
  }

  const usernameMatch = path.match(/^([A-Za-z0-9_]{5,})(?:\/\d+)?$/);
  if (!usernameMatch) {
    return { ok: false, status: 'UNSUPPORTED_URL', error: 'Поддерживаются только ссылки на публичные каналы t.me/<username>' };
  }

  return { ok: true, type: 'public', username: usernameMatch[1] };
}

function fetchLastPostsFromPublicChannel_(username, limit) {
  const posts = [];
  let beforePostId = null;

  while (posts.length < limit) {
    const pagePosts = fetchChannelPagePosts_(username, beforePostId);
    if (pagePosts.length === 0) break;

    for (const p of pagePosts) {
      if (posts.length >= limit) break;
      posts.push(p);
    }

    const minId = pagePosts.reduce((acc, p) => Math.min(acc, p.postId), Number.MAX_SAFE_INTEGER);
    if (!isFinite(minId) || minId <= 1) break;

    beforePostId = minId;
  }

  return posts.slice(0, limit);
}

function fetchChannelPagePosts_(username, beforePostId) {
  let url = `https://t.me/s/${encodeURIComponent(username)}`;
  if (beforePostId) {
    url += `?before=${beforePostId}`;
  }

  const response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    validateHttpsCertificates: true,
    method: 'get',
    timeout: REQUEST_TIMEOUT_MS
  });

  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error(`HTTP ${code} при загрузке ${url}`);
  }

  const html = response.getContentText();
  return parsePostsFromHtml_(html);
}

function parsePostsFromHtml_(html) {
  const blocks = [];
  const blockRegex = /<div class="tgme_widget_message[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;
  const matched = html.match(blockRegex) || [];

  for (const block of matched) {
    const postAttr = block.match(/data-post="([^"]+)"/);
    if (!postAttr) continue;

    const postPath = postAttr[1];
    const postIdMatch = postPath.match(/\/(\d+)$/);
    if (!postIdMatch) continue;

    const postId = Number(postIdMatch[1]);

    const textPartMatch = block.match(/<div class="tgme_widget_message_text[\s\S]*?<\/div>/);
    const textHtml = textPartMatch ? textPartMatch[0] : '';
    const text = stripHtml_(textHtml).trim();

    const urlMatches = [];
    const hrefRegex = /href="(https?:\/\/[^"#]+)"/g;
    let m;
    while ((m = hrefRegex.exec(block)) !== null) {
      urlMatches.push(decodeHtmlEntities_(m[1]));
    }

    blocks.push({ postId, text, urls: urlMatches });
  }

  return blocks;
}

function analyzePosts_(posts) {
  const hashtagRegex = /(^|\s)#реклама(\b|$)/i;
  const yaCcRegex = /^https:\/\/ya\.cc/i;

  const hashtagPostIds = [];
  const hashtagAndYaCcPostIds = [];

  for (const post of posts) {
    const hasHashtag = hashtagRegex.test(post.text);
    const hasYaCc = post.urls.some((u) => yaCcRegex.test(u));

    if (hasHashtag) {
      hashtagPostIds.push(post.postId);
      if (hasYaCc) {
        hashtagAndYaCcPostIds.push(post.postId);
      }
    }
  }

  const note = posts.length < MAX_POSTS_TO_CHECK
    ? `Доступно только ${posts.length} постов в публичной ленте`
    : '';

  return {
    checkedCount: posts.length,
    hashtagCount: hashtagPostIds.length,
    hashtagAndYaCcCount: hashtagAndYaCcPostIds.length,
    hashtagPostIds,
    hashtagAndYaCcPostIds,
    note
  };
}

function stripHtml_(html) {
  return decodeHtmlEntities_(
    html
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
  );
}

function decodeHtmlEntities_(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
