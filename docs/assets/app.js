const ACCESS_HASH = 'c4dcda6cf4762236b76b916976e3072c8048427755d91dfb3a094a5e3c021e0a';
const PAGE_SIZE = 40;
let topics = [];
let documents = [];
let activeCategory = '전체';
let activeFormat = '전체';
let visibleCount = PAGE_SIZE;
let query = '';
let activePreview = null;
let viewerVisiblePages = 40;
const previewCache = new Map();

const $ = (selector) => document.querySelector(selector);
const loginView = $('#loginView');
const appView = $('#appView');

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
}

function unlock() {
  sessionStorage.setItem('company-unlocked', '1');
  loginView.hidden = true;
  appView.hidden = false;
  document.body.classList.add('unlocked');
  loadData();
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = $('#password').value;
  if (await sha256(value) === ACCESS_HASH) {
    $('#loginError').textContent = '';
    unlock();
  } else {
    $('#loginError').textContent = '접속 코드가 일치하지 않습니다.';
    $('#password').select();
  }
});

$('#logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('company-unlocked');
  location.reload();
});

async function loadData() {
  if (topics.length) return;
  try {
    const [topicResponse, documentResponse] = await Promise.all([
      fetch('./data/topics.json'),
      fetch('./data/documents.json')
    ]);
    if (!topicResponse.ok || !documentResponse.ok) throw new Error('데이터를 불러오지 못했습니다.');
    topics = await topicResponse.json();
    const documentData = await documentResponse.json();
    documents = Array.isArray(documentData) ? documentData : Object.values(documentData);
    $('#topicCount').textContent = topics.length.toLocaleString('ko-KR');
    $('#docCount').textContent = documents.length.toLocaleString('ko-KR');
    createFilters();
    renderAll();
  } catch (error) {
    $('#topicGrid').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function normalize(value) {
  return String(value || '').toLocaleLowerCase('ko-KR').replace(/\s+/g, ' ');
}

function searchableTopic(topic) {
  return normalize([topic.title, topic.summary, topic.content_markdown, ...(topic.category || [])].join(' '));
}

function searchableDocument(doc) {
  return normalize([doc.title, doc.relative_path, doc.format, doc.scope, doc.category, ...(doc.search_tokens || [])].join(' '));
}

function createFilters() {
  const topicCategories = ['전체', ...new Set(topics.flatMap(topic => topic.category || []))];
  $('#categoryFilters').innerHTML = topicCategories.map(category =>
    `<button class="chip ${category === '전체' ? 'active' : ''}" data-category="${escapeAttr(category)}">${escapeHtml(category)}</button>`
  ).join('');
  $('#categoryFilters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]');
    if (!button) return;
    activeCategory = button.dataset.category;
    visibleCount = PAGE_SIZE;
    document.querySelectorAll('[data-category]').forEach(el => el.classList.toggle('active', el === button));
    renderAll();
  });

  const formats = ['전체', ...new Set(documents.map(doc => doc.format || doc.extension?.toUpperCase()).filter(Boolean))].sort((a,b) => a === '전체' ? -1 : a.localeCompare(b));
  $('#formatFilters').innerHTML = formats.slice(0, 12).map(format =>
    `<button class="chip ${format === '전체' ? 'active' : ''}" data-format="${escapeAttr(format)}">${escapeHtml(format)}</button>`
  ).join('');
  $('#formatFilters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-format]');
    if (!button) return;
    activeFormat = button.dataset.format;
    visibleCount = PAGE_SIZE;
    document.querySelectorAll('[data-format]').forEach(el => el.classList.toggle('active', el === button));
    renderDocuments();
  });
}

function renderAll() {
  renderTopics();
  renderDocuments();
}

function renderTopics() {
  const filtered = topics.filter(topic => {
    const categoryMatch = activeCategory === '전체' || (topic.category || []).includes(activeCategory);
    return categoryMatch && (!query || searchableTopic(topic).includes(query));
  });
  $('#topicGrid').innerHTML = filtered.length ? filtered.map((topic, index) => `
    <article class="topic-card" tabindex="0" data-topic-id="${topic.id}">
      <span class="topic-index">${String(index + 1).padStart(2, '0')} / ${String(filtered.length).padStart(2, '0')}</span>
      <h4>${escapeHtml(topic.title)}</h4>
      <p>${escapeHtml(topic.summary)}</p>
      <div class="topic-tags">${(topic.category || []).map(tag => `<span># ${escapeHtml(tag)}</span>`).join('')}</div>
    </article>`).join('') : '<div class="empty-state">일치하는 백과 문서가 없습니다.</div>';
}

function filteredDocuments() {
  const selectedCategoryTokens = activeCategory === '전체' ? [] : normalize(activeCategory).split(/[·\s]+/).filter(Boolean);
  const list = documents.filter(doc => {
    const categoryMatch = activeCategory === '전체' || selectedCategoryTokens.some(token => searchableDocument(doc).includes(token));
    const format = doc.format || doc.extension?.toUpperCase();
    return categoryMatch && (activeFormat === '전체' || format === activeFormat) && (!query || searchableDocument(doc).includes(query));
  });
  const sort = $('#sortSelect').value;
  list.sort((a, b) => sort === 'size-desc' ? (b.size_bytes || 0) - (a.size_bytes || 0) : sort === 'path' ? a.relative_path.localeCompare(b.relative_path, 'ko') : a.title.localeCompare(b.title, 'ko'));
  return list;
}

function renderDocuments() {
  const filtered = filteredDocuments();
  $('#resultCount').textContent = filtered.length.toLocaleString('ko-KR');
  const shown = filtered.slice(0, visibleCount);
  $('#documentRows').innerHTML = shown.length ? shown.map(doc => `
    <tr>
      <td><div class="doc-title">${escapeHtml(doc.title)}</div><div class="doc-path">${escapeHtml(doc.relative_path)}</div></td>
      <td>${escapeHtml(prettyCategory(doc))}</td>
      <td><span class="format-badge">${escapeHtml(doc.format || doc.extension?.toUpperCase() || 'FILE')}</span></td>
      <td>${formatBytes(doc.size_bytes)}</td>
      <td><button class="preview-btn" data-preview-path="${escapeAttr(doc.relative_path)}" ${doc.preview_available ? '' : 'disabled'}>바로 보기</button></td>
      <td><a class="notion-link" href="${escapeAttr(doc.notion_url)}" target="_blank" rel="noopener">열기 ↗</a></td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty-state">일치하는 원본 문서가 없습니다.</td></tr>';
  $('#loadMoreBtn').hidden = shown.length >= filtered.length;
}

function prettyCategory(doc) {
  const path = doc.relative_path || '';
  const parts = path.split('/');
  if (parts[0]?.startsWith('95_')) return '보안자료';
  if (parts[0]?.startsWith('99_')) return '중복보존';
  return String(doc.scope || doc.category || parts[0] || '기타').replace(/^\d+_/, '').replaceAll('_', ' ');
}

function openTopic(topic) {
  $('#dialogCategory').textContent = (topic.category || []).join(' · ');
  $('#dialogTitle').textContent = topic.title;
  $('#dialogSummary').textContent = topic.summary;
  $('#dialogContent').innerHTML = renderMarkdown(topic.content_markdown || '');
  $('#dialogNotionLink').href = topic.url;
  $('#topicDialog').showModal();
}

$('#topicGrid').addEventListener('click', (event) => {
  const card = event.target.closest('[data-topic-id]');
  if (card) openTopic(topics.find(topic => topic.id === card.dataset.topicId));
});
$('#topicGrid').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') event.target.closest('[data-topic-id]')?.click();
});
$('#closeDialog').addEventListener('click', () => $('#topicDialog').close());
$('#topicDialog').addEventListener('click', (event) => { if (event.target === $('#topicDialog')) $('#topicDialog').close(); });
$('#searchInput').addEventListener('input', (event) => {
  query = normalize(event.target.value);
  visibleCount = PAGE_SIZE;
  renderAll();
});
$('#sortSelect').addEventListener('change', renderDocuments);
$('#loadMoreBtn').addEventListener('click', () => { visibleCount += PAGE_SIZE; renderDocuments(); });

$('#documentRows').addEventListener('click', (event) => {
  const button = event.target.closest('[data-preview-path]');
  if (!button) return;
  const doc = documents.find(item => item.relative_path === button.dataset.previewPath);
  if (doc) openDocument(doc);
});

async function openDocument(doc) {
  const dialog = $('#documentDialog');
  activePreview = null;
  viewerVisiblePages = 40;
  $('#viewerFormat').textContent = `${doc.format || doc.extension?.toUpperCase() || 'FILE'} · 웹 미리보기`;
  $('#viewerTitle').textContent = doc.title;
  $('#viewerPath').textContent = doc.relative_path;
  $('#viewerEngine').textContent = '변환 데이터를 불러오는 중…';
  $('#viewerNotionLink').href = doc.notion_url;
  $('#viewerStatus').hidden = false;
  $('#viewerStatus').textContent = '문서를 불러오는 중입니다…';
  $('#viewerContent').innerHTML = '';
  $('#viewerSearch').value = '';
  dialog.showModal();
  try {
    let preview = previewCache.get(doc.preview_id);
    if (!preview) {
      const response = await fetch(`./previews/${encodeURIComponent(doc.preview_id)}.json`);
      if (!response.ok) throw new Error(`미리보기 요청 실패 (${response.status})`);
      preview = await response.json();
      previewCache.set(doc.preview_id, preview);
    }
    activePreview = preview;
    $('#viewerEngine').textContent = `${preview.engine || '정적 변환'}${preview.page_count ? ` · ${preview.page_count.toLocaleString('ko-KR')}쪽` : ''}${preview.redacted ? ' · 보호정보 자동 마스킹' : ''}`;
    renderDocumentPreview(preview);
  } catch (error) {
    $('#viewerStatus').textContent = `미리보기를 열 수 없습니다: ${error.message}`;
  }
}

function renderDocumentPreview(preview, term = '') {
  const content = $('#viewerContent');
  $('#viewerStatus').hidden = true;
  if (preview.media_url) {
    content.innerHTML = `<figure class="image-preview"><img src="${escapeAttr(preview.media_url)}" alt="${escapeAttr(preview.title)}" loading="lazy"><figcaption>${escapeHtml(preview.title)}</figcaption></figure>`;
    return;
  }
  const source = String(preview.content || '추출 가능한 본문이 없습니다.');
  const normalizedTerm = normalize(term);
  const chunks = preview.page_count ? source.split(/\n\n---\n\n(?=## \d+쪽)/) : [source];
  const indexedChunks = chunks.map((chunk, index) => ({chunk, index}));
  const selected = normalizedTerm
    ? indexedChunks.filter(item => normalize(item.chunk).includes(normalizedTerm)).slice(0, 100)
    : indexedChunks.slice(0, viewerVisiblePages);
  content.innerHTML = selected.map(({chunk, index}) => {
    let body = escapeHtml(chunk);
    if (normalizedTerm) {
      const safe = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      body = body.replace(new RegExp(`(${safe})`, 'giu'), '<mark>$1</mark>');
    }
    const label = preview.page_count ? `<span class="page-stamp">${index + 1} / ${chunks.length}</span>` : '';
    return `<section class="document-page">${label}<pre>${body}</pre></section>`;
  }).join('') + (!normalizedTerm && viewerVisiblePages < chunks.length ? `<button class="viewer-load-more" data-viewer-more>다음 ${Math.min(40, chunks.length - viewerVisiblePages)}쪽 보기</button>` : '');
  if (normalizedTerm && selected.length === 0) content.innerHTML = '<div class="viewer-no-result">현재 문서에서 일치하는 내용이 없습니다.</div>';
  if (normalizedTerm) content.querySelector('mark')?.scrollIntoView({block: 'center'});
}

$('#viewerSearch').addEventListener('input', (event) => {
  if (activePreview) renderDocumentPreview(activePreview, event.target.value);
});
$('#viewerContent').addEventListener('click', (event) => {
  if (!event.target.closest('[data-viewer-more]') || !activePreview) return;
  viewerVisiblePages += 40;
  renderDocumentPreview(activePreview, $('#viewerSearch').value);
});
$('#closeDocumentDialog').addEventListener('click', () => $('#documentDialog').close());
$('#documentDialog').addEventListener('click', (event) => { if (event.target === $('#documentDialog')) $('#documentDialog').close(); });
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !appView.hidden) {
    event.preventDefault(); $('#searchInput').focus();
  }
  if (event.key === 'Escape' && $('#topicDialog').open) $('#topicDialog').close();
  if (event.key === 'Escape' && $('#documentDialog').open) $('#documentDialog').close();
});

function renderMarkdown(markdown) {
  const lines = String(markdown).split('\n');
  let html = '', list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    if (line.startsWith('## ')) { closeList(); html += `<h2>${inline(line.slice(3))}</h2>`; }
    else if (/^- /.test(line)) { if (list !== 'ul') { closeList(); list = 'ul'; html += '<ul>'; } html += `<li>${inline(line.slice(2))}</li>`; }
    else if (/^\d+\. /.test(line)) { if (list !== 'ol') { closeList(); list = 'ol'; html += '<ol>'; } html += `<li>${inline(line.replace(/^\d+\. /, ''))}</li>`; }
    else { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  closeList(); return html;
}

function inline(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function escapeAttr(value) { return escapeHtml(value); }
function formatBytes(bytes = 0) { if (!bytes) return '—'; const units=['B','KB','MB','GB']; const i=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),3); return `${(bytes/1024**i).toFixed(i ? 1 : 0)} ${units[i]}`; }

if (sessionStorage.getItem('company-unlocked') === '1') unlock();
