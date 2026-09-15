import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { documentUrl, localPath, renderMarkdown } from './markdown';
import { renderDiagrams } from './diagrams';
import { translationSegments, translateSegments, aiTranslationPrompt } from './translation';
import './style.css';

const native = isTauri();
let currentPath = '';
let currentContent = '';
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
  <main><header><div class="file-label"><span>▤</span><span id="filename">시작하기</span></div><div class="toolbar"><button id="translate" title="본문 텍스트를 Google로 전송합니다. 비공식 연결로 서비스 제한 시 실패할 수 있습니다." disabled>한국어로 번역</button><button id="ai-translate" title="사용 중인 AI 서비스로 번역하기" disabled>AI로 번역</button><button id="reload" title="파일 다시 읽기" disabled>↻</button><button id="theme" title="밝은 / 어두운 테마 전환">◐</button></div></header>
    <div id="error" role="alert" hidden></div>
    <div id="reader"><section id="welcome"><div class="eyebrow">A LITTLE SPACE FOR YOUR WORDS</div><h1>Markdown을,<br><span>편안하게 읽으세요.</span></h1><p>복잡한 도구 없이 문서에만 집중하세요.<br>파일을 열면, 읽기 좋은 페이지가 됩니다.</p><button id="welcome-open" class="primary">Markdown 파일 열기 <span>↗</span></button><div class="drop-hint">또는 이곳에 파일을 끌어다 놓으세요</div><div class="welcome-footer"><span>◎ OS 기본 WebView</span><span>↳ .md · .markdown · .mdown</span></div></section><article id="document" hidden></article></div>
    <footer><span id="location">MDV · Markdown Viewer</span><span id="details">읽을 준비가 되었습니다</span></footer></main>
  <dialog id="translation-dialog" aria-labelledby="ai-heading"><h2 id="ai-heading">AI로 번역</h2><p>아래 요청문과 원문을 복사한 뒤 사용 중인 AI 서비스에 붙여넣으세요. 번역 결과는 해당 서비스에서 확인합니다.</p><label for="ai-prompt">번역 요청문과 원문</label><textarea id="ai-prompt" readonly spellcheck="false"></textarea><p>문서는 자동 전송되지 않습니다. 긴 문서는 서비스의 입력 한도에 맞게 나누거나 파일로 첨부하세요.</p><div class="ai-services"><button data-ai-url="https://chatgpt.com/">ChatGPT 열기</button><button data-ai-url="https://gemini.google.com/">Gemini 열기</button><button data-ai-url="https://claude.ai/">Claude 열기</button></div><p id="ai-status" role="status"></p><div class="dialog-actions"><button id="translation-close">닫기</button><button id="ai-copy">요청문 복사</button></div></dialog>
  <div id="translation-status" role="status" hidden></div>
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
  resetTranslation();
  currentContent = content;
  $<HTMLButtonElement>('#ai-translate').disabled = false;
  if ($<HTMLDialogElement>('#translation-dialog').open) $<HTMLDialogElement>('#translation-dialog').close();
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
  void renderDiagrams(article);
}
async function load(path: string) {
  cancelTranslation();
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
  cancelTranslation();
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
$('#theme').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; localStorage.setItem('mdv-theme', theme); void renderDiagrams($('#document')); };
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

let translationRun = 0;
let translating = false;
let translatedView = false;
let translationNodes: ReturnType<typeof translationSegments> = [];
let translatedTexts: string[] | null = null;
const translateButton = $<HTMLButtonElement>('#translate');
const translationStatus = $('#translation-status');
// Status belongs to the reader area, not the app's horizontal layout.
$('#reader').before(translationStatus);
function cancelTranslation() {
  translationRun++;
  translating = false;
  if (translateButton) translateButton.textContent = translatedView ? '원문 보기' : '한국어로 번역';
  if (translationStatus) translationStatus.hidden = true;
}
function resetTranslation() {
  cancelTranslation();
  translatedView = false;
  translationNodes = [];
  translatedTexts = null;
  translateButton.disabled = !native;
  translateButton.textContent = '한국어로 번역';
}
function updateTranslationView() {
  translationNodes.forEach((segment, index) => {
    segment.node.data = translatedView ? translatedTexts![index] : segment.original;
  });
  const headings = [...$('#document').querySelectorAll('h1,h2,h3')];
  $('#toc').querySelectorAll('a').forEach((link, index) => { link.textContent = headings[index]?.textContent || ''; });
  translateButton.textContent = translatedView ? '원문 보기' : '한국어로 번역';
  translationStatus.hidden = !translatedView;
  translationStatus.textContent = '한국어 번역 · Google (비공식 연결)';
}
$('#ai-translate').onclick = () => {
  $<HTMLTextAreaElement>('#ai-prompt').value = aiTranslationPrompt(currentContent);
  $('#ai-status').textContent = '';
  $<HTMLDialogElement>('#translation-dialog').showModal();
};
$('#translation-close').onclick = () => $<HTMLDialogElement>('#translation-dialog').close();
$('#translation-dialog').addEventListener('close', () => { $<HTMLTextAreaElement>('#ai-prompt').value = ''; });
$('#ai-copy').onclick = async () => {
  const field = $<HTMLTextAreaElement>('#ai-prompt');
  try {
    await navigator.clipboard.writeText(field.value);
    $('#ai-status').textContent = '복사했습니다. AI 서비스에서 붙여넣고 전송하세요.';
  } catch {
    field.focus(); field.select();
    $('#ai-status').textContent = '자동 복사가 지원되지 않습니다. 선택된 요청문을 Ctrl+C / Cmd+C로 복사하세요.';
  }
};
$('#translation-dialog').querySelectorAll<HTMLButtonElement>('[data-ai-url]').forEach(button => {
  button.onclick = async () => {
    try {
      if (native) await openUrl(button.dataset.aiUrl!);
      else window.open(button.dataset.aiUrl!, '_blank', 'noopener,noreferrer');
    } catch { $('#ai-status').textContent = '브라우저를 열 수 없습니다. 사용 중인 AI 서비스를 직접 열어 주세요.'; }
  };
});
translateButton.onclick = async () => {
  if (translating) { cancelTranslation(); return; }
  if (translatedTexts) { translatedView = !translatedView; updateTranslationView(); return; }
  const run = ++translationRun;
  translationNodes = translationSegments($('#document'));
  if (!translationNodes.length) {
    translationStatus.hidden = false;
    translationStatus.textContent = '번역할 영문 텍스트가 없습니다.';
    return;
  }
  translating = true;
  translateButton.textContent = '번역 취소';
  $('#error').hidden = true;
  translationStatus.hidden = false;
  translationStatus.textContent = 'Google로 번역 중…';
  try {
    const result = await translateSegments(translationNodes,
      async texts => {
        const result = await invoke<string[]>('translate_text', { texts });
        await new Promise(resolve => setTimeout(resolve, 150));
        return result;
      },
      () => run === translationRun,
      (done, total) => { translationStatus.textContent = `Google로 번역 중… ${Math.round(done / total * 100)}%`; });
    if (run !== translationRun || !result) return;
    translatedTexts = result;
    translatedView = true;
    updateTranslationView();
  } catch (reason) {
    if (run === translationRun) { error(reason); translationStatus.hidden = true; }
  } finally {
    if (run === translationRun) {
      translating = false;
      translateButton.textContent = translatedView ? '원문 보기' : '한국어로 번역';
    }
  }
};
