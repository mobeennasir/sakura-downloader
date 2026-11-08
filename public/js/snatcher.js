(() => {
  'use strict';

  // Same host allowlist as the server. Client-side only — the server enforces it.
  const HOST_PLATFORM = {
    'instagram.com': 'instagram',
    'www.instagram.com': 'instagram',
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

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    if (diff < 60 * 1000) return 'just now';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  // --- status line + loading screen -----------------------------------------
  // The status line carries the text (and the spinner) for screen readers;
  // the loading screen is the visual: the galaxy over frosted glass. Both
  // are driven by the same calls, so they never disagree.
  const statusLine = $('#statusLine');
  const loadingScreen = $('#loadingScreen');
  const loadingText = $('#loadingText');
  const loadingElapsed = $('#loadingElapsed');
  let statusTimer = null;
  let currentAbort = null;

  function showLoading(label) {
    if (loadingScreen) {
      loadingScreen.classList.add('is-visible');
      loadingScreen.setAttribute('aria-hidden', 'false');
    }
    if (loadingText) loadingText.textContent = label;
    if (loadingElapsed) loadingElapsed.textContent = '';
  }

  function hideLoading() {
    if (loadingScreen) {
      loadingScreen.classList.remove('is-visible');
      loadingScreen.setAttribute('aria-hidden', 'true');
    }
    if (loadingElapsed) loadingElapsed.textContent = '';
  }

  function setStatus(text, { alert = false, spinner = false } = {}) {
    if (!statusLine) return;
    hideLoading();
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
    showLoading(label);
    statusTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - started) / 1000);
      const base = statusLine.textContent.replace(/ · \d+s$/, '');
      statusLine.textContent = `${base} · ${secs}s`;
      if (loadingElapsed) loadingElapsed.textContent = `${secs}s`;
    }, 1000);
  }

  function clearStatus() {
    hideLoading();
    clearInterval(statusTimer);
    statusTimer = null;
    if (statusLine) statusLine.textContent = '';
  }

  // --- download loader ------------------------------------------------------
  // A Download click used to navigate straight to /dl with no feedback at
  // all — on a throttled pipe the user stared at a dead page for 30–50 s.
  // Now the click fetches the file through the loader: a real progress
  // ring (bytes received vs the signed size), MB numbers, elapsed time,
  // and a Cancel button. Files over 200 MB skip the loader and navigate
  // directly: holding a huge file as a blob would eat the phone's memory,
  // and the browser's own download UI is the right tool for those. Any
  // fetch failure also falls back to a plain navigation, so the download
  // still happens. (The save itself is a blob-URL anchor click after the
  // async fetch — it works in Chrome/Firefox/Safari; the navigation
  // fallback covers any browser that refuses it.)
  const DOWNLOAD_LOADER_MAX_BYTES = 200 * 1024 * 1024;
  const downloadLoader = $('#downloadLoader');
  const downloadRingFill = $('#downloadRingFill');
  const downloadName = $('#downloadName');
  const downloadPercent = $('#downloadPercent');
  const downloadBytes = $('#downloadBytes');
  const downloadElapsed = $('#downloadElapsed');
  const downloadCancel = $('#downloadCancel');
  const RING_CIRCUMFERENCE = 2 * Math.PI * 30;
  let downloadAbort = null;

  function formatMB(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  function showDownloadLoader(filename) {
    if (!downloadLoader) return;
    downloadLoader.classList.add('is-visible');
    // Waiting for the first byte (the server is still fetching or
    // converting the file): say so and pulse the ring, instead of a flat
    // 0% that reads as stuck — on a throttled pipe the first byte can
    // take 10–20 s to arrive.
    downloadLoader.classList.add('is-waiting');
    downloadLoader.setAttribute('aria-hidden', 'false');
    if (downloadName) downloadName.textContent = filename || 'Downloading…';
    if (downloadRingFill) downloadRingFill.style.strokeDashoffset = RING_CIRCUMFERENCE;
    if (downloadPercent) downloadPercent.textContent = '0%';
    if (downloadBytes) downloadBytes.textContent = 'Getting your file ready…';
    if (downloadElapsed) downloadElapsed.textContent = '';
    if (downloadCancel) downloadCancel.textContent = 'Cancel';
  }

  // A failed download shows its error in the loader, with a Dismiss
  // button — it used to fall back to a plain navigation, which landed
  // the user on a bare 502/JSON page that read as a dead page.
  function showDownloadError(message) {
    if (!downloadLoader) return;
    downloadLoader.classList.add('is-visible');
    downloadLoader.classList.remove('is-waiting');
    downloadLoader.setAttribute('aria-hidden', 'false');
    if (downloadName) downloadName.textContent = 'Download failed';
    if (downloadPercent) downloadPercent.textContent = '—';
    if (downloadBytes) downloadBytes.textContent = message;
    if (downloadElapsed) downloadElapsed.textContent = '';
    if (downloadCancel) downloadCancel.textContent = 'Dismiss';
  }

  function hideDownloadLoader() {
    if (!downloadLoader) return;
    downloadLoader.classList.remove('is-visible');
    downloadLoader.setAttribute('aria-hidden', 'true');
  }

  function navigateDownload(url) {
    window.location.assign(url);
  }

  async function startDownload(url, filename) {
    // Total size: the signed `s=` in the /dl URL when the resolver knew it.
    let total = null;
    try {
      const s = new URL(url, window.location.origin).searchParams.get('s');
      if (/^\d+$/.test(s || '')) total = parseInt(s, 10);
    } catch {
      // Unparseable URL — fall through to the response header.
    }
    if (total && total > DOWNLOAD_LOADER_MAX_BYTES) {
      navigateDownload(url);
      return;
    }
    const controller = new AbortController();
    downloadAbort = controller;
    const started = Date.now();
    showDownloadLoader(filename);
    const elapsedTimer = setInterval(() => {
      if (downloadElapsed) {
        downloadElapsed.textContent = `${Math.floor((Date.now() - started) / 1000)}s`;
      }
    }, 1000);
    // The fetch used to hang forever when the server stalled (no timeout
    // at all) — the loader sat at 0% until the user gave up. Cap it at
    // 60 s so a stalled download fails visibly instead of hanging.
    let timedOut = false;
    const fetchTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`server answered ${res.status}`);
      if (!total) {
        const len = parseInt(res.headers.get('content-length') || '', 10);
        if (Number.isFinite(len) && len > 0) total = len;
      }
      if (total && total > DOWNLOAD_LOADER_MAX_BYTES) {
        // Too big to hold as a blob — hand it to the browser instead.
        hideDownloadLoader();
        navigateDownload(url);
        return;
      }
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (!reader) throw new Error('streaming not supported');
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        // First byte arrived: the wait is over, switch to real progress.
        if (downloadLoader) downloadLoader.classList.remove('is-waiting');
        if (total) {
          const pct = Math.min(100, Math.round((received / total) * 100));
          if (downloadPercent) downloadPercent.textContent = `${pct}%`;
          if (downloadRingFill) {
            downloadRingFill.style.strokeDashoffset =
              RING_CIRCUMFERENCE * (1 - received / total);
          }
          if (downloadBytes) {
            downloadBytes.textContent = `${formatMB(received)} of ${formatMB(total)}`;
          }
        } else if (downloadBytes) {
          downloadBytes.textContent = `${formatMB(received)} downloaded`;
        }
      }
      const blob = new Blob(chunks);
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename || 'snatcher_media';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      hideDownloadLoader();
      setStatus('Downloaded.');
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (timedOut) {
          showDownloadError('Took too long — try again.');
        } else {
          hideDownloadLoader();
          setStatus('Download cancelled.');
        }
      } else {
        showDownloadError(
          err && err.message
            ? `Download failed (${err.message}). Try again.`
            : 'Download failed. Try again.'
        );
      }
    } finally {
      clearInterval(elapsedTimer);
      clearTimeout(fetchTimer);
      if (downloadAbort === controller) downloadAbort = null;
    }
  }

  if (downloadCancel) {
    downloadCancel.addEventListener('click', () => {
      if (downloadAbort) {
        downloadAbort.abort();
      } else {
        // Error state (no fetch in flight): the button is Dismiss.
        hideDownloadLoader();
        downloadCancel.textContent = 'Cancel';
      }
    });
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

  // `caption` is the post's caption (batch mode only): when given, the
  // caption box sits inside the card, below the buttons, so every video
  // carries its own caption with it. Single mode passes nothing and
  // keeps the one shared caption box below the grid instead.
  // `sourceUrl` (batch mode only) is the link the card came from, shown
  // shortened (domain + path, no tracking query) under the title.
  function mediaCard(item, index, caption, sourceUrl) {
    const card = el('article', { class: 'media-card' });
    const preview = el('div', { class: 'preview' });
    // HLS manifests (.m3u8) do not play in a plain <video> element — show
    // the thumbnail instead; the Download button still saves a real mp4.
    // Items without a direct media URL show the thumbnail too.
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
      // A photo's preview IS the photo: the backend hands every item in a
      // carousel the same post thumbnail, so `thumbnail || url` showed one
      // photo on all ten cards while the downloads (which use `url`) were
      // all different files. Use the item's own URL for photos; the
      // thumbnail stays as the fallback for videos/HLS items that have no
      // direct URL to show.
      const img = el('img', {
        src: item.type === 'image' ? (item.url || item.thumbnail) : (item.thumbnail || item.url),
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
    if (sourceUrl) {
      let short = String(sourceUrl);
      try {
        const u = new URL(short);
        short = `${u.hostname}${u.pathname}`;
      } catch {
        // Unparseable — show it as-is.
      }
      body.appendChild(el('p', { class: 'source-url', text: short }));
    }

    const actions = el('div', { class: 'actions' });
    const download = el('a', {
      class: 'btn btn--primary',
      href: item.downloadUrl,
      download: item.filename || '',
    }, [icon('download'), document.createTextNode('Download')]);
    // The click goes through the download loader (real progress ring +
    // cancel) instead of navigating straight to /dl with no feedback —
    // on a throttled pipe the user stared at a dead page for 30–50 s.
    // Merged / converted files take a while before the first byte (the
    // server fetches them to disk first); the loader's elapsed timer is
    // the hint there.
    download.addEventListener('click', (event) => {
      event.preventDefault();
      startDownload(item.downloadUrl, item.filename || '');
    });
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
    // Batch mode: the post's caption lives in the card itself, below the
    // buttons — one per video, with its own Copy button.
    const cap = caption ? captionSection(caption) : null;
    if (cap) body.appendChild(cap);
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
    // One Download all for the whole batch: every file from every link
    // that worked, skipping the ones that failed. A failed link never
    // blocks the rest — it is counted in the note, not in the downloads.
    const ok = results.filter((r) => r.success && r.mediaItems && r.mediaItems.length > 0);
    const allItems = ok.flatMap((r) => r.mediaItems);
    const failed = results.length - ok.length;
    if (allItems.length > 1) {
      const head = el('div', { class: 'results-head' });
      head.appendChild(el('h2', { text: 'Batch downloads' }));
      const note = failed > 0
        ? `${allItems.length} files from ${ok.length} link${ok.length === 1 ? '' : 's'} · ${failed} link${failed === 1 ? '' : 's'} failed — skipped`
        : `${allItems.length} files from ${ok.length} link${ok.length === 1 ? '' : 's'}`;
      head.appendChild(el('p', { text: note }));
      const all = el('button', { class: 'btn btn--secondary', type: 'button' }, [icon('download'), document.createTextNode('Download all')]);
      all.addEventListener('click', () => {
        allItems.forEach((item, i) => {
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
      container.appendChild(head);
    }
    // One shared grid for the whole batch: cards from different links sit
    // side by side in rows. A per-link grid put one card per row whenever
    // a link had a single video — six single-video links read as a column,
    // even on desktop. Each card carries its own source link (shortened,
    // under the title), so the cards still show which link they came from
    // without a full-width header breaking the row.
    if (ok.length > 0) {
      const grid = el('div', { class: 'media-grid' });
      ok.forEach((result) => {
        result.mediaItems.forEach((item, i) =>
          grid.appendChild(mediaCard(item, i, result.caption, result.url))
        );
      });
      container.appendChild(grid);
    }
    // Failed links keep their own block, after the grid — a failed link
    // never blocks the rest.
    results.forEach((result) => {
      if (result.success && result.mediaItems && result.mediaItems.length > 0) return;
      const group = el('div', { class: 'batch-group' });
      group.appendChild(el('p', { class: 'batch-url', text: result.url }));
      const empty = el('div', { class: 'empty-state' });
      empty.appendChild(el('h3', { text: 'Could not grab this one.' }));
      empty.appendChild(el('p', { text: result.error || 'No media found.' }));
      group.appendChild(empty);
      container.appendChild(group);
    });
  }

  // --- single resolve ------------------------------------------------------------
  async function runSingle(url, platform, { mediaType } = {}) {
    const detected = platform || detectPlatform(url);
    if (!detected) {
      goToErrorPage({ code: 'invalid_url' }, url);
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
