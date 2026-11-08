(() => {
  'use strict';

  // Same host allowlist as the server. Client-side only — the server enforces it.
  const HOST_PLATFORM = {
    'instagram.com': 'instagram',
    'www.instagram.com': 'instagram',
    'youtube.com': 'youtube',
    'www.youtube.com': 'youtube',
    'youtu.be': 'youtube',
    'music.youtube.com': 'youtube',
    'www.music.youtube.com': 'youtube',
    'pinterest.com': 'pinterest',
    'www.pinterest.com': 'pinterest',
    'pin.it': 'pinterest',
    'tiktok.com': 'tiktok',
    'www.tiktok.com': 'tiktok',
    'vt.tiktok.com': 'tiktok',
    'vm.tiktok.com': 'tiktok',
    'facebook.com': 'facebook',
    'www.facebook.com': 'facebook',
    'fb.watch': 'facebook',
    'twitter.com': 'twitter',
    'www.twitter.com': 'twitter',
    'x.com': 'twitter',
    'www.x.com': 'twitter',
  };

  const PLATFORM_NAMES = {
    instagram: 'Instagram',
    youtube: 'YouTube',
    pinterest: 'Pinterest',
    tiktok: 'TikTok',
    facebook: 'Facebook',
    twitter: 'Twitter/X',
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.startsWith('aria') || key === 'role' || key === 'for') node.setAttribute(key.replace(/([A-Z])/g, '-$1').toLowerCase(), value);
        else node.setAttribute(key, value);
      }
    }
    if (children) {
      for (const child of children) {
        if (child) node.appendChild(child);
      }
    }
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  function detectPlatform(rawUrl) {
    try {
      return HOST_PLATFORM[new URL(String(rawUrl).trim()).hostname.toLowerCase()] || null;
    } catch {
      return null;
    }
  }

  function fmtBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function fmtDuration(seconds) {
    if (!seconds) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    if (diff < 60 * 1000) return 'just now';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  // --- status line ---------------------------------------------------------
  const statusLine = $('#statusLine');
  let statusTimer = null;
  let currentAbort = null;

  function setStatus(text, { alert = false, spinner = false } = {}) {
    if (!statusLine) return;
    clearInterval(statusTimer);
    statusTimer = null;
    statusLine.textContent = '';
    statusLine.removeAttribute('role');
    if (spinner) {
      const spin = el('span', { class: 'spinner', 'aria-hidden': 'true' });
      statusLine.appendChild(spin);
    }
    statusLine.appendChild(document.createTextNode(text));
    if (alert) statusLine.setAttribute('role', 'alert');
  }

  function setLoading(label) {
    const started = Date.now();
    setStatus(`${label} `, { spinner: true });
    statusTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - started) / 1000);
      const base = statusLine.textContent.replace(/ · \d+s$/, '');
      statusLine.textContent = `${base} · ${secs}s`;
    }, 1000);
  }

  function clearStatus() {
    clearInterval(statusTimer);
    statusTimer = null;
    if (statusLine) statusLine.textContent = '';
  }

  async function postJson(path, body, timeoutMs) {
    const controller = new AbortController();
    currentAbort = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs || 60000);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = new Error(data.error || 'Something went wrong.');
        error.code = data.code || 'unknown';
        throw error;
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') {
        const error = new Error('Took too long. Try again.');
        error.code = 'timeout';
        throw error;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      currentAbort = null;
    }
  }

  // A failed resolve or convert goes to the dedicated animated error page,
  // keyed by the server's error code — not the inline status line. The page
  // has its own "Try again" (back) and "Back home" actions, plus a
  // WhatsApp report button. The link that failed rides along as ?url= so
  // the report comes prefilled — the user only has to tap send.
  function goToErrorPage(err, url) {
    const code =
      err && typeof err.code === 'string' && /^[a-z_]+$/.test(err.code) ? err.code : 'unknown';
    const suffix =
      typeof url === 'string' && url.trim()
        ? `&url=${encodeURIComponent(url.trim())}`
        : '';
    window.location.assign(`/error?code=${code}${suffix}`);
  }

  // --- results ---------------------------------------------------------------
  const resultsEl = $('#results');
  let lastResult = null; // { platform, title, items } for client-side filtering

  function metaLine(item) {
    const parts = [];
    parts.push(item.type === 'video' ? 'Video' : item.type === 'audio' ? 'Audio' : 'Photo');
    if (item.quality) parts.push(item.quality);
    if (item.width && item.height) parts.push(`${item.width}×${item.height}`);
    const size = fmtBytes(item.size);
    if (size) parts.push(size);
    return parts.join(' · ');
  }

  function mediaCard(item, index) {
    const card = el('article', { class: 'media-card' });
    const preview = el('div', { class: 'preview' });
    // HLS manifests (.m3u8) do not play in a plain <video> element — show
    // the thumbnail instead; the Download button still saves a real mp4.
    // Items without a direct media URL (e.g. YouTube batch items) show the
    // thumbnail too.
    if (item.type === 'video' && item.url && !/\.m3u8(\?|$)/i.test(item.url)) {
      const video = el('video', {
        src: item.url,
        preload: 'metadata',
        playsinline: '',
        controls: '',
      });
      if (item.thumbnail) video.setAttribute('poster', item.thumbnail);
      preview.appendChild(video);
    } else {
      const img = el('img', {
        src: item.thumbnail || item.url,
        alt: item.title || `Image ${index + 1}`,
        loading: 'lazy',
      });
      preview.appendChild(img);
    }
    preview.appendChild(el('span', { class: 'type-badge', text: item.type === 'video' ? 'Video' : 'Photo' }));
    card.appendChild(preview);

    const body = el('div', { class: 'body' });
    body.appendChild(el('p', { class: 'title', text: item.title || `${item.type === 'video' ? 'Video' : 'Photo'} ${index + 1}` }));
    body.appendChild(el('p', { class: 'meta', text: metaLine(item) }));

    const actions = el('div', { class: 'actions' });
    const download = el('a', {
      class: 'btn btn--primary',
      href: item.downloadUrl,
      download: item.filename || '',
    }, [icon('download'), document.createTextNode('Download')]);
    // Merged / converted files are fetched to the server first so the
    // browser gets an exact size — say so, or the pause looks broken.
    if (item.ytdlp && (String(item.ytdlp.formatId || '').includes('+') || /\.m3u8(\?|$)/i.test(item.url || ''))) {
      download.addEventListener('click', () => {
        setStatus('Getting your file ready — the download starts in a moment.');
      });
    }
    const copy = el('button', { class: 'btn btn--secondary', type: 'button' }, [icon('copy'), document.createTextNode('Copy link')]);
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.sourceUrl || item.url);
        copy.textContent = '';
        copy.appendChild(icon('check'));
        copy.appendChild(document.createTextNode('Copied'));
        copy.classList.add('is-settled');
        setTimeout(() => {
          copy.textContent = '';
          copy.classList.remove('is-settled');
          copy.appendChild(icon('copy'));
          copy.appendChild(document.createTextNode('Copy link'));
        }, 2000);
      } catch {
        setStatus('Copy did not work — long-press the link instead.', { alert: true });
      }
    });
    actions.appendChild(download);
    actions.appendChild(copy);
    body.appendChild(actions);
    card.appendChild(body);
    return card;
  }

  // One caption per post/video, shown below the download buttons: the
  // fetched caption text in a box, with a copy button. Returns null when
  // the source gave no caption — the box simply does not appear.
  function captionSection(caption) {
    if (!caption) return null;
    const section = el('section', { class: 'caption-box' });
    section.appendChild(el('p', { class: 'caption-label', text: 'Caption' }));
    const box = el('textarea', {
      class: 'caption-text',
      readonly: '',
      rows: '4',
      'aria-label': 'Caption',
    });
    box.value = caption;
    section.appendChild(box);
    const copy = el('button', { class: 'btn btn--secondary', type: 'button' }, [icon('copy'), document.createTextNode('Copy caption')]);
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(caption);
        copy.textContent = '';
        copy.appendChild(icon('check'));
        copy.appendChild(document.createTextNode('Copied'));
        copy.classList.add('is-settled');
        setTimeout(() => {
          copy.textContent = '';
          copy.classList.remove('is-settled');
          copy.appendChild(icon('copy'));
          copy.appendChild(document.createTextNode('Copy caption'));
        }, 2000);
      } catch {
        setStatus('Copy did not work — select the text and copy it manually.', { alert: true });
      }
    });
    section.appendChild(copy);
    return section;
  }

  function renderMediaResult(container, result, { filter } = {}) {
    lastResult = result;
    container.textContent = '';
    const items = filter && filter !== 'all'
      ? result.items.filter((item) => item.type === (filter === 'photo' ? 'image' : 'video'))
      : result.items;
    const head = el('div', { class: 'results-head' });
    head.appendChild(el('h2', { text: result.title || 'Media' }));
    const count = items.length === 1 ? '1 item' : `${items.length} items`;
    const note = result.items.length !== items.length
      ? `${count} shown · ${result.items.length} found`
      : count;
    head.appendChild(el('p', { text: note }));
    if (items.length > 1) {
      const all = el('button', { class: 'btn btn--secondary', type: 'button' }, [icon('download'), document.createTextNode('Download all')]);
      all.addEventListener('click', () => {
        items.forEach((item, i) => {
          setTimeout(() => {
            const a = document.createElement('a');
            a.href = item.downloadUrl;
            a.download = item.filename || '';
            document.body.appendChild(a);
            a.click();
            a.remove();
          }, i * 450);
        });
        setStatus('Downloading all — your browser may ask to allow multiple downloads.');
      });
      head.appendChild(all);
    }
    container.appendChild(head);

    if (items.length === 0) {
      const empty = el('div', { class: 'empty-state' });
      empty.appendChild(el('h3', { text: 'Nothing of that kind here.' }));
      empty.appendChild(el('p', { text: 'This link has no photos or no videos — try the other filter, or another link.' }));
      container.appendChild(empty);
      return;
    }
    const grid = el('div', { class: 'media-grid' });
    items.forEach((item, i) => grid.appendChild(mediaCard(item, i)));
    container.appendChild(grid);
    const caption = captionSection(result.caption);
    if (caption) container.appendChild(caption);
  }

  function renderEmpty(container, title, line) {
    container.textContent = '';
    const empty = el('div', { class: 'empty-state' });
    empty.appendChild(el('h3', { text: title }));
    empty.appendChild(el('p', { text: line }));
    container.appendChild(empty);
  }

  function renderBatchResult(container, results) {
    container.textContent = '';
    results.forEach((result) => {
      const group = el('div', { class: 'batch-group' });
      group.appendChild(el('p', { class: 'batch-url', text: result.url }));
      if (result.success && result.mediaItems && result.mediaItems.length > 0) {
        const head = el('div', { class: 'results-head' });
        head.appendChild(el('h2', { text: result.title || 'Media' }));
        head.appendChild(el('p', { text: `${result.mediaItems.length} item${result.mediaItems.length === 1 ? '' : 's'}` }));
        group.appendChild(head);
        const grid = el('div', { class: 'media-grid' });
        result.mediaItems.forEach((item, i) => grid.appendChild(mediaCard(item, i)));
        group.appendChild(grid);
        const caption = captionSection(result.caption);
        if (caption) group.appendChild(caption);
      } else {
        const empty = el('div', { class: 'empty-state' });
        empty.appendChild(el('h3', { text: 'Could not grab this one.' }));
        empty.appendChild(el('p', { text: result.error || 'No media found.' }));
        group.appendChild(empty);
      }
      container.appendChild(group);
    });
  }

  // --- YouTube two-step flow ---------------------------------------------------
  async function runYouTube(url) {
    setLoading('Asking YouTube for the video info…');
    const infoRes = await postJson('/api/youtube/info', { url }, 150000);
    const info = infoRes.data;
    clearStatus();

    resultsEl.textContent = '';
    const summary = el('div', { class: 'video-summary' });
    if (info.thumbnail) {
      summary.appendChild(el('img', { src: info.thumbnail, alt: '' }));
    }
    const sumBody = el('div');
    sumBody.appendChild(el('p', { class: 'title', text: info.title }));
    const meta = [info.author, fmtDuration(info.duration)].filter(Boolean).join(' · ');
    if (meta) sumBody.appendChild(el('p', { class: 'meta', text: meta }));
    summary.appendChild(sumBody);
    resultsEl.appendChild(summary);

    // Video and Audio as separate sections: one row per format, each with
    // its own Download button. Clicking it downloads exactly that format —
    // no separate pick-then-convert step.
    async function downloadFormat(format, button) {
      button.disabled = true;
      setLoading('Getting your file ready…');
      try {
        const conv = await postJson('/api/youtube/convert', { url, formatId: format.id }, 120000);
        clearStatus();
        const a = document.createElement('a');
        a.href = conv.data.downloadUrl;
        a.download = conv.data.filename || '';
        document.body.appendChild(a);
        a.click();
        a.remove();
        saveRecent(url, 'youtube', info.title);
      } catch (err) {
        goToErrorPage(err, url);
      } finally {
        button.disabled = false;
      }
    }

    function formatSection(heading, formats) {
      if (!formats || formats.length === 0) return;
      const head = el('div', { class: 'results-head' });
      head.appendChild(el('h2', { text: heading }));
      resultsEl.appendChild(head);
      const list = el('div', { class: 'format-list' });
      formats.forEach((format) => {
        const row = el('div', { class: 'format-row' });
        row.appendChild(el('span', { class: 'format-label', text: format.label }));
        const size = fmtBytes(format.size);
        if (size) row.appendChild(el('span', { class: 'format-size', text: size }));
        const dl = el('button', { class: 'btn btn--primary', type: 'button' }, [icon('download'), document.createTextNode('Download')]);
        dl.addEventListener('click', () => downloadFormat(format, dl));
        row.appendChild(dl);
        list.appendChild(row);
      });
      resultsEl.appendChild(list);
    }

    formatSection('Video', info.videoFormats || info.formats.filter((f) => f.type === 'mp4'));
    formatSection('Audio', info.audioFormats || info.formats.filter((f) => f.type === 'audio'));

    // The caption sits below the downloads, with its copy button.
    const caption = captionSection(info.caption);
    if (caption) resultsEl.appendChild(caption);

  }

  // --- single resolve ------------------------------------------------------------
  async function runSingle(url, platform, { mediaType } = {}) {
    const detected = platform || detectPlatform(url);
    if (!detected) {
      goToErrorPage({ code: 'invalid_url' }, url);
      return;
    }
    if (detected === 'youtube') {
      try {
        await runYouTube(url);
      } catch (err) {
        goToErrorPage(err, url);
      }
      return;
    }
    setLoading(`Asking ${PLATFORM_NAMES[detected]} for the media…`);
    try {
      const data = await postJson(`/${detected}/download`, { url, mediaType }, 60000);
      clearStatus();
      renderMediaResult(resultsEl, {
        platform: detected,
        title: data.title,
        caption: data.caption,
        items: data.mediaItems,
      });
      saveRecent(url, detected, data.title);
    } catch (err) {
      goToErrorPage(err, url);
    }
  }

  // --- hamburger ---------------------------------------------------------------
  // Small screens only: the toggle button is hidden by CSS on desktop, and
  // the nav is always visible there — this is a no-op in that case.
  function wireNavToggle() {
    const toggle = $('.nav-toggle');
    const header = $('.site-header');
    if (!toggle || !header) return;
    function setOpen(open) {
      header.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
    }
    toggle.addEventListener('click', () => {
      setOpen(!header.classList.contains('nav-open'));
    });
    // A tap on a link, or Escape, closes the menu again.
    header.addEventListener('click', (event) => {
      if (event.target.closest('.site-nav a')) setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setOpen(false);
    });
  }

  // --- history ---------------------------------------------------------------------
  const RECENT_KEY = 'snatcher:recent';
  function loadRecent() {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    } catch {
      return [];
    }
  }
  function saveRecent(url, platform, title) {
    try {
      const list = loadRecent().filter((entry) => entry.url !== url);
      list.unshift({ url, platform, title: title || '', at: Date.now() });
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
      renderRecent();
    } catch {
      // Private mode or storage full — history is a nicety, not a feature.
    }
  }
  function renderRecent() {
    const section = $('#recentSection');
    const list = $('#recentList');
    if (!section || !list) return;
    const items = loadRecent();
    if (items.length === 0) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    list.textContent = '';
    items.forEach((entry) => {
      const li = el('li');
      const a = el('a', {
        href: `/${entry.platform}?url=${encodeURIComponent(entry.url)}`,
        text: entry.title ? `${entry.title} — ${entry.url}` : entry.url,
      });
      li.appendChild(a);
      li.appendChild(el('time', { text: timeAgo(entry.at) }));
      list.appendChild(li);
    });
  }

  // --- wiring ----------------------------------------------------------------------
  function wirePasteButton() {
    const pasteBtn = $('#pasteBtn');
    const input = $('#urlInput');
    if (!pasteBtn || !input) return;
    pasteBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          input.value = text.trim();
          input.focus();
          return;
        }
      } catch {
        // Clipboard unavailable — fall through to the manual hint.
      }
      input.focus();
      setStatus('Clipboard is blocked here — paste with Ctrl+V / long-press.');
    });
  }

  function wirePlatformPage() {
    const form = $('#platformForm');
    if (!form) return;
    const platform = document.body.dataset.platform;
    const input = $('#urlInput');
    const filter = $('#mediaFilter');

    // Deep link: ?url= prefills the bar.
    const params = new URLSearchParams(window.location.search);
    const preset = params.get('url');
    if (preset) input.value = preset;

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const url = input.value.trim();
      if (!url) {
        setStatus('Paste a link first.', { alert: true });
        return;
      }
      const mediaType = filter
        ? (filter.querySelector('input[name="mediaType"]:checked') || {}).value || 'all'
        : undefined;
      resultsEl.textContent = '';
      runSingle(url, platform, { mediaType }).catch((err) => {
        goToErrorPage(err);
      });
    });

    // The Pinterest filter re-filters the last result instantly, no re-fetch.
    if (filter) {
      filter.addEventListener('change', () => {
        if (!lastResult) return;
        const value = (filter.querySelector('input[name="mediaType"]:checked') || {}).value || 'all';
        renderMediaResult(resultsEl, lastResult, { filter: value });
      });
    }
  }

  function wireHomePage() {
    const singleForm = $('#singleForm');
    if (!singleForm) return;
    const input = $('#urlInput');
    const singleBtn = $('#modeSingleBtn');
    const batchBtn = $('#modeBatchBtn');
    const batchBox = $('#batchBox');
    const batchInput = $('#batchInput');
    const batchGo = $('#batchBtn');

    const params = new URLSearchParams(window.location.search);
    const preset = params.get('url');
    if (preset) input.value = preset;

    function setMode(mode) {
      const single = mode === 'single';
      singleBtn.setAttribute('aria-pressed', String(single));
      batchBtn.setAttribute('aria-pressed', String(!single));
      singleForm.hidden = !single;
      batchBox.hidden = single;
      if (single) input.focus();
      else batchInput.focus();
    }
    singleBtn.addEventListener('click', () => setMode('single'));
    batchBtn.addEventListener('click', () => setMode('batch'));

    singleForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const url = input.value.trim();
      if (!url) {
        setStatus('Paste a link first.', { alert: true });
        return;
      }
      resultsEl.textContent = '';
      runSingle(url, null).catch((err) => {
        goToErrorPage(err);
      });
    });

    batchGo.addEventListener('click', async () => {
      const urls = [...new Set(
        batchInput.value.split('\n').map((line) => line.trim()).filter(Boolean)
      )];
      if (urls.length === 0) {
        setStatus('Paste at least one link — one per line.', { alert: true });
        return;
      }
      if (urls.length > 10) {
        setStatus('At most 10 links per batch.', { alert: true });
        return;
      }
      batchGo.disabled = true;
      setLoading(`Snatching ${urls.length} link${urls.length === 1 ? '' : 's'}…`);
      try {
        const data = await postJson('/api/batch', { urls }, 120000);
        clearStatus();
        renderBatchResult(resultsEl, data.results);
        data.results.forEach((result) => {
          if (result.success) saveRecent(result.url, result.platform, result.title);
        });
      } catch (err) {
        goToErrorPage(err);
      } finally {
        batchGo.disabled = false;
      }
    });

    const clearRecent = $('#clearRecentBtn');
    if (clearRecent) {
      clearRecent.addEventListener('click', () => {
        try {
          localStorage.removeItem(RECENT_KEY);
        } catch {
          // ignore
        }
        renderRecent();
      });
    }
  }

  wirePasteButton();
  wireNavToggle();
  wirePlatformPage();
  wireHomePage();
  renderRecent();
})();
