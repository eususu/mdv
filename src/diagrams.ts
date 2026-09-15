import DOMPurify from 'dompurify';
import { deflateSync, strToU8 } from 'fflate';

let sequence = 0;
let queue: Promise<void> = Promise.resolve();

async function mermaidSvg(source: string, dark: boolean): Promise<string> {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: dark ? 'dark' : 'default',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    fontFamily: 'Arial, sans-serif',
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'flowchart'],
  });
  const id = `mdv-diagram-${++sequence}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['foreignObject', 'a', 'image'],
    });
  } finally {
    // Mermaid may leave its temporary error container after a failed render.
    document.getElementById(`d${id}`)?.remove();
  }
}

export function plantumlUrl(source: string): string {
  const bytes = deflateSync(strToU8(source));
  const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
  const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    .replace(/=+$/, '').replace(/./g, char => alphabet[base64.indexOf(char)]);
  return `https://www.plantuml.com/plantuml/svg/${encoded}`;
}

export function renderDiagrams(root: HTMLElement): Promise<void> {
  const dark = document.documentElement.dataset.theme === 'dark';
  const jobs: Promise<void>[] = [];
  root.querySelectorAll<HTMLElement>('pre > code').forEach(code => {
    const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9).toLowerCase();
    const plantuml = language === 'plantuml' || language === 'puml';
    if (!plantuml && language !== 'mermaid' && language !== 'mermaidjs') return;
    if (plantuml && code.closest('.diagram')) return;
    const pre = code.parentElement!;
    const source = code.textContent || '';
    const old = pre.closest('.diagram') || pre;
    const figure = document.createElement('figure');
    figure.className = 'diagram';
    const caption = document.createElement('figcaption');
    caption.textContent = plantuml ? 'PlantUML' : 'Mermaid';
    const status = document.createElement('p');
    status.className = 'diagram-status';
    status.setAttribute('role', 'status');
    status.textContent = '다이어그램을 그리는 중…';
    const output = document.createElement('div');
    output.className = 'diagram-output';
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '소스 보기';
    old.replaceWith(figure);
    details.append(summary, pre);
    figure.append(caption, status, output, details);
    if (plantuml) {
      status.textContent = '온라인 렌더링을 사용하면 이 블록의 코드가 plantuml.com으로 전송됩니다.';
      const button = document.createElement('button');
      button.textContent = 'plantuml.com에 전송하여 그리기';
      figure.insertBefore(button, output);
      button.onclick = () => {
        const url = plantumlUrl(source);
        if (url.length > 16000) {
          status.textContent = '온라인으로 그리기에는 다이어그램이 너무 큽니다. 블록을 나누어 주세요.';
          details.open = true;
          return;
        }
        button.disabled = true;
        status.classList.remove('diagram-error');
        status.textContent = '다이어그램을 불러오는 중…';
        const image = document.createElement('img');
        image.alt = 'PlantUML 다이어그램';
        image.referrerPolicy = 'no-referrer';
        let timer: ReturnType<typeof setTimeout>;
        const failed = () => {
          clearTimeout(timer);
          image.onload = image.onerror = null;
          image.removeAttribute('src');
          image.remove();
          if (!root.contains(figure)) return;
          status.hidden = false;
          status.textContent = '다이어그램을 불러올 수 없습니다. 인터넷 연결과 소스 문법을 확인한 뒤 다시 시도하세요.';
          status.classList.add('diagram-error');
          details.open = true;
          button.disabled = false;
          button.textContent = '다시 전송하여 그리기';
        };
        image.onload = () => {
          clearTimeout(timer);
          image.onload = image.onerror = null;
          status.hidden = true;
          button.hidden = true;
        };
        image.onerror = failed;
        timer = setTimeout(failed, 20000);
        image.src = url;
        output.replaceChildren(image);
      };
      return;
    }
    const job = async () => {
      if (!root.contains(figure)) return;
      try {
        const svg = await mermaidSvg(source, dark);
        if (!root.contains(figure)) return;
        const image = document.createElement('img');
        image.alt = 'Mermaid 다이어그램';
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        output.append(image);
        status.hidden = true;
      } catch {
        if (!root.contains(figure)) return;
        status.textContent = '다이어그램을 그릴 수 없습니다. 아래 소스의 문법을 확인하세요.';
        status.classList.add('diagram-error');
        details.open = true;
      }
    };
    queue = queue.then(job, job);
    jobs.push(queue);
  });
  return Promise.all(jobs).then(() => {});
}
