import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { documentUrl, localPath, renderMarkdown } from './markdown';
import './style.css';

const native = isTauri();
let currentPath = '';
let generation = 0;
type RecentFile = { path: string; name: string; file?: File };
const recentKey = 'mdv-recent-files';
const recentLimit = 10;
let recentFiles: RecentFile[] = [];
if (native) {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(recentKey) || '[]');
    if (Array.isArray(saved)) {
      const paths = [...new Set(saved.filter((path): path is string => typeof path === 'string' && path.trim().length > 0))];
      recentFiles = paths.slice(0, recentLimit).map(path => ({ path, name: path.split(/[\\/]/).pop() || path }));
    }
  } catch { /* Unavailable storage or invalid history must not prevent opening files. */ }
}
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
$('#app').innerHTML = `
  <aside class="sidebar"><div class="brand"><span class="mark">M↓</span><span>mdv<span class="brand-caption">MARKDOWN VIEWER</span></span></div>
    <button class="open-button" id="open">＋ <span>파일 열기</span><kbd>⌘ / Ctrl O</kbd></button>
    <section class="recent-section" aria-labelledby="recent-heading"><div class="recent-heading"><h2 id="recent-heading" class="section-label">최근 열어본 파일</h2><button id="clear-recent" title="최근 파일 목록 전체 지우기">지우기</button></div><ul id="recent-files"></ul><p id="recent-empty" class="muted">최근 열어본 파일이 없습니다.</p><p class="muted" id="recent-session" ${native ? 'hidden' : ''}>이 브라우저 세션 동안 유지됩니다.</p></section>
    <div class="section-label">이 문서의 목차</div><nav id="toc" aria-label="문서 목차"><p class="muted">문서를 열면 목차가 표시됩니다.</p></nav>
    <div class="sidebar-bottom"><span class="status-dot"></span>읽기에 집중하는 공간<span>v0.1</span></div></aside>
  <main><header><div class="file-label"><span>▤</span><span id="filename">시작하기</span></div><div class="toolbar"><button id="reload" title="파일 다시 읽기" disabled>↻</button><button id="theme" title="밝은 / 어두운 테마 전환">◐</button></div></header>
    <div id="error" role="alert" hidden></div>
    <div id="reader"><section id="welcome"><div class="eyebrow">A LITTLE SPACE FOR YOUR WORDS</div><h1>Markdown을,<br><span>편안하게 읽으세요.</span></h1><p>복잡한 도구 없이 문서에만 집중하세요.<br>파일을 열면, 읽기 좋은 페이지가 됩니다.</p><button id="welcome-open" class="primary">Markdown 파일 열기 <span>↗</span></button><div class="drop-hint">또는 이곳에 파일을 끌어다 놓으세요</div><div class="welcome-footer"><span>◎ OS 기본 WebView</span><span>↳ .md · .markdown · .mdown</span></div></section><article id="document" hidden></article></div>
    <footer><span id="location">MDV · Markdown Viewer</span><span id="details">읽을 준비가 되었습니다</span></footer></main>
  <input id="browser-file" type="file" accept=".md,.markdown,.mdown" hidden><div id="drop-overlay" hidden>Markdown 파일을 놓아주세요</div>`;

function renderRecent() {
  const list = $('#recent-files');
  list.replaceChildren();
  $('#recent-empty').hidden = recentFiles.length > 0;
  $<HTMLButtonElement>('#clear-recent').disabled = recentFiles.length === 0;
  recentFiles.forEach(entry => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'recent-open';
    button.title = entry.path || entry.name;
    const name = document.createElement('span');
    name.textContent = entry.name;
    button.append(name);
    if (entry.path) {
      const path = document.createElement('small');
      path.textContent = entry.path;
      button.append(path);
      if (entry.path === currentPath) button.setAttribute('aria-current', 'true');
    }
    button.onclick = () => { if (entry.file) void browserFile(entry.file); else void load(entry.path); };
    const remove = document.createElement('button');
    remove.className = 'recent-remove';
    remove.textContent = '×';
    remove.title = `${entry.name} 목록에서 삭제`;
    remove.setAttribute('aria-label', remove.title);
    remove.onclick = () => { recentFiles = recentFiles.filter(file => file !== entry); saveRecent(); };
    item.append(button, remove);
    list.append(item);
  });
}
function saveRecent() {
  if (native) {
    try { localStorage.setItem(recentKey, JSON.stringify(recentFiles.map(entry => entry.path))); }
    catch { /* Keep history usable for this session if storage is unavailable. */ }
  }
  renderRecent();
}
function remember(entry: RecentFile) {
  recentFiles = [entry, ...recentFiles.filter(other => entry.file
    ? !(other.file?.name === entry.file.name && other.file.size === entry.file.size && other.file.lastModified === entry.file.lastModified)
    : other.path !== entry.path)].slice(0, recentLimit);
  saveRecent();
}
$('#clear-recent').onclick = () => { recentFiles = []; saveRecent(); };
renderRecent();

function error(reason: unknown) { $('#error').textContent = String(reason); $('#error').hidden = false; }
function show(content: string, path: string, name?: string) {
  const article = $('#document');
  article.innerHTML = renderMarkdown(content);
  currentPath = path;
  const filename = name || path.split(/[\\/]/).pop() || '문서';
  $('#filename').textContent = filename;
  $('#location').textContent = path || filename;
  $('#location').title = path || filename;
  document.title = `${filename} — MDV`;
  $('#welcome').hidden = true;
  article.hidden = false;
  $('#error').hidden = true;
  $<HTMLButtonElement>('#reload').disabled = !path;
  $('#details').textContent = `${content.length.toLocaleString()}자 · 약 ${Math.max(1, Math.ceil(content.length / 700))}분`;
  const toc = $('#toc'); toc.replaceChildren();
  const headings = [...article.querySelectorAll<HTMLElement>('h1,h2,h3')];
  // Preserve authored IDs for fragment links; generated IDs are stable and unique.
  const ids = new Set([...article.querySelectorAll('[id]')].map(el => el.id));
  headings.forEach((heading, index) => {
    if (!heading.id) {
      const base = heading.textContent!.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-') || `section-${index}`;
      let id = base, suffix = 1;
      while (ids.has(id)) id = `${base}-${suffix++}`;
      heading.id = id; ids.add(id);
    }
    const link = document.createElement('a'); link.textContent = heading.textContent;
    link.href = `#${encodeURIComponent(heading.id)}`;
    link.style.paddingLeft = `${(Number(heading.tagName[1]) - 1) * 12 + 12}px`;
    link.onclick = event => { event.preventDefault(); heading.scrollIntoView({ behavior: 'smooth' }); };
    toc.append(link);
  });
  if (!headings.length) toc.textContent = '이 문서에는 제목이 없습니다.';
  if (path) article.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src'); if (!src) return;
    try { const url = new URL(src, documentUrl(path)); if (url.protocol === 'file:') img.src = convertFileSrc(localPath(url)); } catch { img.removeAttribute('src'); }
  });
  $('#reader').scrollTop = 0;
}
async function load(path: string) {
  const request = ++generation;
  try {
    const doc = await invoke<{ path: string; content: string }>('read_document', { path });
    if (request === generation) {
      show(doc.content, doc.path);
      remember({ path: doc.path, name: doc.path.split(/[\\/]/).pop() || doc.path });
    }
  } catch (reason) { if (request === generation) error(reason); }
}
async function choose() {
  if (!native) { $<HTMLInputElement>('#browser-file').click(); return; }
  try { const path = await open({ multiple: false, filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown'] }] }); if (path) await load(path); } catch (reason) { error(reason); }
}
async function browserFile(file?: File) {
  if (!file) return;
  if (!/\.(md|markdown|mdown)$/i.test(file.name)) { error('Markdown 파일을 선택하세요.'); return; }
  if (file.size > 10 * 1024 * 1024) { error('10MB 이하의 문서를 선택하세요.'); return; }
  const request = ++generation;
  try { const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); if (request === generation) {
    show(content, '', file.name);
    remember({ path: '', name: file.name, file });
  } } catch { if (request === generation) error('UTF-8 문서를 읽을 수 없습니다.'); }
}
$('#open').onclick = choose;
$('#welcome-open').onclick = choose;
$('#reload').onclick = () => { if (currentPath) void load(currentPath); };
$<HTMLInputElement>('#browser-file').onchange = event => { const input = event.target as HTMLInputElement; void browserFile(input.files?.[0]); input.value = ''; };
const savedTheme = localStorage.getItem('mdv-theme');
document.documentElement.dataset.theme = savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
$('#theme').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; localStorage.setItem('mdv-theme', theme); };
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); void choose(); } });
$('#document').onclick = async event => {
  const anchor = (event.target as HTMLElement).closest('a'); if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute('href'); if (!href) return;
  try {
    if (href.startsWith('#')) { document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: 'smooth' }); return; }
    const url = new URL(href, currentPath ? documentUrl(currentPath) : location.href);
    if (['https:', 'http:', 'mailto:'].includes(url.protocol)) {
      if (native) await openUrl(url.href); else window.open(url.href, '_blank', 'noopener,noreferrer');
    } else if (url.protocol === 'file:' && /\.(md|markdown|mdown)$/i.test(url.pathname)) {
      await load(localPath(url));
      if (url.hash) document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
    } else error('웹 링크와 Markdown 문서 링크만 열 수 있습니다.');
  } catch (reason) { error(reason); }
};
if (native) {
  // Subscribe before draining the pending path: Finder may send its event before the UI loads.
  const pending = async () => { const path = await invoke<string | null>('take_pending'); if (path) await load(path); };
  void (async () => {
    await listen('open-document', () => { void pending().catch(error); });
    await getCurrentWindow().onDragDropEvent(event => {
      $('#drop-overlay').hidden = event.payload.type !== 'over';
      if (event.payload.type === 'drop' && event.payload.paths[0]) void load(event.payload.paths[0]);
    });
    await pending();
  })().catch(error);
} else {
  document.addEventListener('dragover', event => { event.preventDefault(); });
  document.addEventListener('drop', event => { event.preventDefault(); void browserFile(event.dataTransfer?.files[0]); });
}
