/**
 * 介绍页的交互装配。
 *
 * 保持极薄是有意的：这页只需要三件事——复制接入指令、挂上演示、跟着场景换一句说明。
 * 装箱、计费、渲染一行都不在这里，全在 core/ 和 ui/ 里，和 H5 工具端共用。
 */
import { mountDemo, demoScenarios } from './tree.js';

const $ = sel => document.querySelector(sel);

/* ── 复制接入指令 ─────────────────────────────────────────
   指令正文放在 HTML 的 <pre> 里，不写在 JS 字符串里：
   这样它是页面上唯一的一份、可以被搜到、也不会和 JS 里的转义打架。
   页面上默认折叠，用户点一下就能先看看再决定要不要发出去。 */
const promptText = () => ($('#agent-prompt')?.textContent || '').trim();

async function copy(text) {
  // 优先走 Clipboard API。它只在 https / localhost 下可用，
  // 降级路径用 textarea + execCommand，老 Safari 与内网 http 还能用。
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 权限被拒或未聚焦页面，走下面的兜底 */
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function bindCopy(btn) {
  const label = btn.querySelector('span') || btn;
  const original = label.textContent;
  let timer = 0;

  btn.addEventListener('click', async () => {
    const ok = await copy(promptText());
    if (!ok) {
      label.textContent = '复制失败，请手动选中';
      // 复制失败时把折叠区展开：至少让人能手动全选，别卡在无路可走的状态
      const pre = $('#agent-prompt');
      if (pre && pre.closest('details')) pre.closest('details').open = true;
      setTimeout(() => { label.textContent = original; }, 2600);
      return;
    }
    label.textContent = '已复制 ✓';
    btn.classList.add('done');
    const hint = $('#copy-hint');
    if (hint) hint.textContent = '粘贴给 Agent 即可，路径记得替换成你自己的仓库位置';

    clearTimeout(timer);
    timer = setTimeout(() => {
      label.textContent = original;
      btn.classList.remove('done');
      if (hint) hint.textContent = '复制后粘贴给 Claude Code / WorkBuddy / DSH 等任意 Agent';
    }, 2600);
  });
}

document.querySelectorAll('.copy-big, [data-copy-prompt]').forEach(bindCopy);

/* ── 演示区 ─────────────────────────────────────────────
   tree.js 会真跑一遍引擎，所以它的挂载要等 DOM 就绪。
   脚本是 type=module，本身就延后到解析完成，但保险起见仍判一次。 */
const mount = $('#demo-mount');
if (mount) {
  const caption = $('#demo-caption');
  const showCaption = i => {
    const s = demoScenarios[i];
    if (caption && s) caption.innerHTML = `<b>${s.label}</b> · ${s.hint}`;
  };
  mountDemo(mount, showCaption);
  showCaption(0);
}