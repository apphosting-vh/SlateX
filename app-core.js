/* ============================================================================
 * Slate — a quiet, offline-first home for tasks and notes.
 * ----------------------------------------------------------------------------
 * Storage tiers:
 *   1. localStorage  — preferences, theme, active view (instant, synchronous)
 *   2. IndexedDB     — primary database for notes + tasks (async, structured)
 *   3. File System Access API — automatic mirror to a user-chosen folder
 *   4. Service Worker — full offline app shell, installable on Windows
 *
 * No frameworks beyond React, no build step, no network calls after install.
 * ==========================================================================*/
(function () {
  'use strict';

  const { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } = React;

  const APP_VERSION = '1.2.0';
  const SCHEMA_VERSION = 2;
  const PREFS_KEY = 'slate:prefs:v1';
  const FALLBACK_PREFIX = 'slate:data:v1:';

  /* --------------------------------------------------------------------------
   * Small utilities
   * ------------------------------------------------------------------------*/

  let uidCounter = 0;
  const uid = () => {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (err) { /* fall through */ }
    uidCounter += 1;
    return 'n' + Date.now().toString(36) + uidCounter.toString(36) + Math.random().toString(36).slice(2, 8);
  };

  const cx = (...parts) => parts.filter(Boolean).join(' ');
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const pad2 = (n) => String(n).padStart(2, '0');
  const toDayKey = (date = new Date()) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const parseDayKey = (key) => {
    const parts = String(key).split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  };

  const formatRelative = (timestamp) => {
    if (!timestamp) return '';
    const diff = Date.now() - timestamp;
    if (diff < 45 * 1000) return 'just now';
    if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.round(diff / 60000))}m ago`;
    if (diff < 24 * 60 * 60 * 1000 && new Date(timestamp).toDateString() === new Date().toDateString()) {
      return `${Math.max(1, Math.round(diff / 3600000))}h ago`;
    }
    if (diff < 48 * 60 * 60 * 1000) return 'yesterday';
    if (diff < 7 * 24 * 60 * 60 * 1000) {
      return new Date(timestamp).toLocaleDateString(undefined, { weekday: 'short' });
    }
    const date = new Date(timestamp);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' })
    });
  };

  const formatBytes = (bytes) => {
    if (!bytes || bytes < 0) return '0 KB';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const dueInfo = (due) => {
    const target = due ? parseDayKey(due) : null;
    if (!target || Number.isNaN(target.getTime())) return null;
    const today = startOfDay(new Date());
    const diff = Math.round((target.getTime() - today.getTime()) / 86400000);

    if (diff === 0) return { label: 'Today', tone: 'today', diff };
    if (diff === 1) return { label: 'Tomorrow', tone: 'soon', diff };
    if (diff === -1) return { label: 'Yesterday', tone: 'overdue', diff };
    if (diff < 0) return { label: `${Math.abs(diff)}d overdue`, tone: 'overdue', diff };

    const sameYear = target.getFullYear() === today.getFullYear();
    return {
      label: target.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(sameYear ? {} : { year: 'numeric' })
      }),
      tone: 'later',
      diff
    };
  };

  const slugify = (value) => {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 70);
  };

  const noteTitle = (note) => (note && note.title && note.title.trim()) || 'Untitled note';

  const noteExcerpt = (note) => {
    if (!note || !note.body) return 'Empty note';
    const text = note.body
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*_`~\[\]()!|-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text ? text.slice(0, 100) : 'Empty note';
  };

  const wordCount = (text) => {
    const trimmed = String(text || '').trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  };

  const downloadFile = (filename, content, type) => {
    const blob = new Blob([content], { type: type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const titleSuffix = (id) => {
    const clean = String(id || '').replace(/[^a-zA-Z0-9]/g, '');
    return clean.slice(-8) || 'note';
  };

  const noteFileName = (note) => `${slugify(note.title).slice(0, 64) || 'untitled'}-${titleSuffix(note.id)}.md`;

  const noteToMarkdown = (note, options = {}) => {
    const includeFrontmatter = options.frontmatter !== false;
    const title = (note.title || '').trim();
    const body = String(note.body || '').replace(/\s+$/, '');
    const lines = [];

    if (includeFrontmatter) {
      lines.push('---');
      lines.push(`id: ${note.id}`);
      lines.push(`title: ${JSON.stringify(title)}`);
      lines.push(`created: ${new Date(note.createdAt || Date.now()).toISOString()}`);
      lines.push(`updated: ${new Date(note.updatedAt || Date.now()).toISOString()}`);
      lines.push(`pinned: ${note.pinned ? 'true' : 'false'}`);
      if (note.notebookId) lines.push(`notebookId: ${note.notebookId}`);
      if (options.notebook && options.notebook.name) {
        lines.push(`notebook: ${JSON.stringify(options.notebook.name)}`);
      }
      lines.push('---');
      lines.push('');
    }

    if (title) lines.push(`# ${title}`, '');
    lines.push(body);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  };

  /* --------------------------------------------------------------------------
   * Preferences (localStorage tier)
   * ------------------------------------------------------------------------*/

  const Prefs = {
    read() {
      try {
        const raw = localStorage.getItem(PREFS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (err) {
        return {};
      }
    },
    get(key, fallback) {
      const value = this.read()[key];
      return value === undefined ? fallback : value;
    },
    set(patch) {
      try {
        const next = { ...this.read(), ...patch };
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
        return true;
      } catch (err) {
        return false;
      }
    }
  };

  /* --------------------------------------------------------------------------
   * Markdown — tiny, dependency-free, and escape-first by design.
   * Supports headings, lists/task lists, quotes, fenced code, rules,
   * links, bold, italic, strike, inline code. Raw HTML is always escaped.
   * ------------------------------------------------------------------------*/

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));

  const safeHref = (url) => {
    const value = String(url || '').trim();
    if (/^(https?:\/\/|mailto:)/i.test(value)) return value;
    return '';
  };

  const renderInline = (source) => {
    if (!source) return '';
    const codes = [];
    const links = [];
    const escaped = [];

    // Backslash escapes let the editor round-trip literal Markdown characters.
    let text = String(source).replace(/\\([\\`*_{}\[\]()#+\-.!~><])/g, (match, char) => {
      escaped.push(char);
      return `\u0002${escaped.length - 1}\u0002`;
    });

    text = text.replace(/`([^`]+)`/g, (match, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });

    text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (match, label, url) => {
      links.push({ label, url });
      return `\u0001${links.length - 1}\u0001`;
    });

    text = escapeHtml(text);

    text = text
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/(^|[\s(>])\*([^*\n]+)\*(?=$|[\s).,!?:;<])/g, '$1<em>$2</em>')
      .replace(/(^|[\s(>])_([^_\n]+)_(?=$|[\s).,!?:;<])/g, '$1<em>$2</em>');

    text = text.replace(/\u0001(\d+)\u0001/g, (match, index) => {
      const link = links[Number(index)];
      if (!link) return '';
      const href = safeHref(link.url);
      const label = escapeHtml(link.label);
      if (!href) return label;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });

    text = text.replace(/\u0000(\d+)\u0000/g, (match, index) => {
      const code = codes[Number(index)];
      return `<code>${escapeHtml(code === undefined ? '' : code)}</code>`;
    });

    text = text.replace(/\u0002(\d+)\u0002/g, (match, index) => (
      escapeHtml(escaped[Number(index)] || '')
    ));

    return text;
  };

  const LIST_RE = /^\s*(?:[-*+]|\d+\.)\s+/;

  const renderMarkdown = (source) => {
    const input = String(source || '').replace(/\r\n?/g, '\n');
    if (!input.trim()) return '';

    const lines = input.split('\n');
    const output = [];
    const paragraph = [];
    let index = 0;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      output.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
      paragraph.length = 0;
    };

    while (index < lines.length) {
      const line = lines[index];

      if (/^\s*```/.test(line)) {
        flushParagraph();
        const language = line.trim().replace(/^```/, '').trim();
        index += 1;
        const code = [];
        while (index < lines.length && !/^\s*```/.test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }
        index += 1;
        const langAttr = language ? ` class="language-${escapeHtml(language.replace(/[^a-zA-Z0-9+#._-]/g, ''))}"` : '';
        output.push(`<pre><code${langAttr}>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        index += 1;
        continue;
      }

      if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
        flushParagraph();
        output.push('<hr>');
        index += 1;
        continue;
      }

      const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        flushParagraph();
        const level = clamp(heading[1].length, 1, 6);
        output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        const quote = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          quote.push(lines[index].replace(/^\s*>\s?/, ''));
          index += 1;
        }
        output.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
        continue;
      }

      if (LIST_RE.test(line)) {
        flushParagraph();
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (index < lines.length && LIST_RE.test(lines[index])) {
          let item = lines[index].replace(LIST_RE, '');
          let checked = null;
          const taskMatch = /^\[([ xX])\]\s*(.*)$/.exec(item);
          if (taskMatch) {
            checked = taskMatch[1].toLowerCase() === 'x';
            item = taskMatch[2];
          }
          items.push({ text: item, checked });
          index += 1;
        }
        const hasTasks = items.some((item) => item.checked !== null);
        const tag = ordered ? 'ol' : 'ul';
        const listClass = hasTasks ? ' class="task-list"' : '';
        const rendered = items
          .map((item) => {
            const box = item.checked === null
              ? ''
              : `<span class="md-check${item.checked ? ' done' : ''}" aria-hidden="true">✓</span>`;
            return `<li>${box}<span>${renderInline(item.text)}</span></li>`;
          })
          .join('');
        output.push(`<${tag}${listClass}>${rendered}</${tag}>`);
        continue;
      }

      paragraph.push(line);
      index += 1;
    }

    flushParagraph();
    return output.join('\n');
  };

  /* --------------------------------------------------------------------------
   * Rich text <-> Markdown bridge.
   * The editor is WYSIWYG, but Markdown stays the single source of truth for
   * storage, search, export and disk sync. These helpers are deliberately
   * small: they only understand the Markdown subset the renderer above emits.
   * ------------------------------------------------------------------------*/

  const EDITOR_BLOCK_TAGS = new Set([
    'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'HR', 'TABLE', 'FIGURE'
  ]);

  const escapeMarkdownText = (value) => String(value).replace(/[\\`*_\[\]~]/g, '\\$&');

  const escapeMarkdownLineStarts = (value) => String(value).split('\n').map((line) => (
    line
      .replace(/^(\s*)([#>])(?=\s)/, '$1\\$2')
      .replace(/^(\s*)([+-])(?=\s)/, '$1\\$2')
      .replace(/^(\s*)(\d+)\.(?=\s)/, '$1$2\\.')
  )).join('\n');

  const wrapInlineMarkdown = (marker, content) => {
    if (!content) return '';
    const leading = content.match(/^\s*/)[0];
    const trailing = content.match(/\s*$/)[0];
    const core = content.slice(leading.length, content.length - trailing.length);
    if (!core) return content;
    return `${leading}${marker}${core}${marker}${trailing}`;
  };

  const inlineToMarkdown = (node, root) => {
    if (!node) return '';
    if (node.nodeType === 3) {
      return escapeMarkdownText(String(node.nodeValue || '').replace(/\u00A0/g, ' '));
    }
    if (node.nodeType !== 1) return '';

    const tag = node.tagName;
    if (tag === 'BR') return '\n';
    if (tag === 'INPUT') return '';

    const children = Array.from(node.childNodes).map((child) => inlineToMarkdown(child, root)).join('');

    if (tag === 'STRONG' || tag === 'B') return wrapInlineMarkdown('**', children);
    if (tag === 'EM' || tag === 'I') return wrapInlineMarkdown('_', children);
    if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return wrapInlineMarkdown('~~', children);

    if (tag === 'CODE') {
      const code = String(node.textContent || '')
        .replace(/\u00A0/g, ' ')
        .replace(/\u200B/g, '')
        .replace(/`/g, "'")
        .replace(/\s*\n\s*/g, ' ')
        .trim();
      return code ? `\`${code}\`` : '';
    }

    if (tag === 'A') {
      const href = safeHref(node.getAttribute('href'));
      if (!href) return children;
      const rawLabel = String(node.textContent || '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/[\[\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const label = rawLabel ? escapeMarkdownText(rawLabel) : escapeMarkdownText(href);
      return `[${label}](${href})`;
    }

    return children;
  };

  const serializeListItem = (item, marker, root) => {
    let task = null;
    const parts = [];
    const nested = [];

    Array.from(item.childNodes).forEach((child) => {
      if (child.nodeType === 1 && child.tagName === 'INPUT' && child.type === 'checkbox') {
        task = Boolean(child.checked);
        return;
      }
      if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) {
        const inner = serializeList(child, root);
        if (inner) nested.push(inner);
        return;
      }
      if (child.nodeType === 1 && (child.tagName === 'P' || child.tagName === 'DIV')) {
        const hasList = Array.from(child.children).some((el) => el.tagName === 'UL' || el.tagName === 'OL');
        if (hasList) {
          Array.from(child.childNodes).forEach((grand) => {
            if (grand.nodeType === 1 && (grand.tagName === 'UL' || grand.tagName === 'OL')) {
              const inner = serializeList(grand, root);
              if (inner) nested.push(inner);
            } else {
              parts.push(inlineToMarkdown(grand, root));
            }
          });
          return;
        }
      }
      parts.push(inlineToMarkdown(child, root));
    });

    const text = parts
      .join('')
      .replace(/\u00A0/g, ' ')
      .replace(/[\t ]*\n[\t ]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text && task === null && !nested.length) return '';
    const prefix = task === null ? marker : (task ? '- [x] ' : '- [ ] ');
    let line = `${prefix}${text}`;

    if (nested.length) {
      const indented = nested.join('\n').split('\n').map((row) => `  ${row}`).join('\n');
      line = `${line}\n${indented}`;
    }
    return line;
  };

  const serializeList = (list, root) => {
    const ordered = list.tagName === 'OL';
    const start = Math.max(1, Number(list.getAttribute('start')) || 1);
    return Array.from(list.children)
      .filter((child) => child.tagName === 'LI')
      .map((item, index) => serializeListItem(item, ordered ? `${start + index}. ` : '- ', root))
      .filter(Boolean)
      .join('\n');
  };

  const serializeBlocks = (root) => {
    const blocks = [];
    let inlineNodes = [];

    const flushInline = () => {
      if (!inlineNodes.length) return;
      const raw = inlineNodes.map((node) => inlineToMarkdown(node, root)).join('');
      inlineNodes = [];
      const text = raw
        .replace(/\u00A0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+|\n+$/g, '');
      if (text.trim()) blocks.push(escapeMarkdownLineStarts(text));
    };

    Array.from(root.childNodes).forEach((child) => {
      if (child.nodeType === 3 || (child.nodeType === 1 && !EDITOR_BLOCK_TAGS.has(child.tagName))) {
        inlineNodes.push(child);
        return;
      }
      if (child.nodeType !== 1) return;

      flushInline();
      const tag = child.tagName;

      if (tag === 'UL' || tag === 'OL') {
        const list = serializeList(child, root);
        if (list) blocks.push(list);
        return;
      }

      if (/^H[1-6]$/.test(tag)) {
        const text = inlineToMarkdown(child, root).replace(/\s+/g, ' ').trim();
        if (text) blocks.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
        return;
      }

      if (tag === 'BLOCKQUOTE') {
        const inner = serializeBlocks(child).join('\n\n');
        if (inner.trim()) {
          blocks.push(inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n'));
        }
        return;
      }

      if (tag === 'PRE') {
        const codeNode = child.querySelector('code');
        const language = codeNode ? (/language-([a-zA-Z0-9+#._-]+)/.exec(codeNode.className) || [])[1] : '';
        const raw = String(child.textContent || '')
          .replace(/\u00A0/g, ' ')
          .replace(/\n$/, '');
        blocks.push(`\`\`\`${language || ''}\n${raw}\n\`\`\``);
        return;
      }

      if (tag === 'HR') {
        blocks.push('---');
        return;
      }

      if (tag === 'TABLE') {
        const rows = Array.from(child.querySelectorAll('tr'))
          .map((row) => Array.from(row.children)
            .map((cell) => String(cell.textContent || '').replace(/\s+/g, ' ').trim())
            .join(' | '))
          .filter(Boolean);
        if (rows.length) blocks.push(rows.join('\n'));
        return;
      }

      const hasBlocks = Array.from(child.children).some((el) => EDITOR_BLOCK_TAGS.has(el.tagName));
      if (hasBlocks) {
        const inner = serializeBlocks(child).join('\n\n');
        if (inner.trim()) blocks.push(inner);
        return;
      }

      const text = inlineToMarkdown(child, root)
        .replace(/\u00A0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/^\n+|\n+$/g, '');
      if (text.trim()) blocks.push(escapeMarkdownLineStarts(text));
    });

    flushInline();
    return blocks;
  };

  const editorHtmlToMarkdown = (root) => {
    if (!root) return '';
    return serializeBlocks(root).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  const markdownToEditorHtml = (source) => {
    const template = document.createElement('template');
    template.innerHTML = renderMarkdown(source);

    template.content.querySelectorAll('.md-check').forEach((mark) => {
      const input = document.createElement('input');
      input.type = 'checkbox';
      const done = mark.classList.contains('done');
      // Serialization back to an HTML string only keeps attributes, so set the
      // default as well as the live property.
      input.checked = done;
      input.defaultChecked = done;
      input.setAttribute('data-task-checkbox', 'true');
      input.setAttribute('contenteditable', 'false');
      input.setAttribute('tabindex', '-1');
      input.setAttribute('aria-label', done ? 'Completed task' : 'Incomplete task');
      mark.replaceWith(input);
    });

    template.content.querySelectorAll('a').forEach((link) => {
      link.setAttribute('title', 'Ctrl+click to open');
    });

    return template.innerHTML;
  };

  const PASTE_TAGS = new Set([
    'P', 'DIV', 'BR', 'STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'STRIKE',
    'CODE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'A'
  ]);

  const PASTE_DROP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META',
    'NOSCRIPT', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT'
  ]);

  // Pasting rich content is allowed, but attributes are stripped so nothing
  // outside the Markdown subset (styles, handlers, images) can enter the page.
  const sanitizePastedHtml = (html) => {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');

    const clean = (parent) => {
      Array.from(parent.childNodes).forEach((child) => {
        if (child.nodeType === 3) return;
        if (child.nodeType !== 1) {
          child.remove();
          return;
        }
        if (!PASTE_TAGS.has(child.tagName)) {
          if (PASTE_DROP_TAGS.has(child.tagName)) {
            child.remove();
            return;
          }
          const fragment = document.createDocumentFragment();
          while (child.firstChild) fragment.appendChild(child.firstChild);
          child.replaceWith(fragment);
          clean(parent);
          return;
        }
        Array.from(child.attributes).forEach((attribute) => {
          if (child.tagName === 'A' && attribute.name === 'href') {
            const href = safeHref(attribute.value);
            if (href) child.setAttribute('href', href);
            else child.removeAttribute('href');
          } else {
            child.removeAttribute(attribute.name);
          }
        });
        clean(child);
      });
    };

    clean(template.content);
    return template.innerHTML;
  };

  /* --------------------------------------------------------------------------
   * Data validation — everything entering state is normalised.
   * ------------------------------------------------------------------------*/

  const PRIORITIES = {
    high: {
      label: 'High',
      dot: 'bg-rose-500',
      chip: 'border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-300',
      text: 'text-rose-600 dark:text-rose-300'
    },
    medium: {
      label: 'Medium',
      dot: 'bg-amber-500',
      chip: 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      text: 'text-amber-700 dark:text-amber-300'
    },
    low: {
      label: 'Low',
      dot: 'bg-sky-500',
      chip: 'border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-300',
      text: 'text-sky-600 dark:text-sky-300'
    },
    none: {
      label: 'No priority',
      dot: 'bg-line/25',
      chip: 'border-line/10 bg-line/[0.04] text-muted',
      text: 'text-muted'
    }
  };

  const PRIORITY_ORDER = { high: 0, medium: 1, low: 2, none: 3 };

  const normalizeNote = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const now = Date.now();
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
      title: typeof raw.title === 'string' ? raw.title.slice(0, 300) : '',
      body: typeof raw.body === 'string' ? raw.body : '',
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
      pinned: Boolean(raw.pinned),
      notebookId: typeof raw.notebookId === 'string' && raw.notebookId ? raw.notebookId : null
    };
  };

  const normalizeNotebook = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const now = Date.now();
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : '';
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
      name: name || 'Untitled notebook',
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now
    };
  };

  const makeNotebook = (name, at = Date.now()) => normalizeNotebook({
    id: uid(),
    name,
    createdAt: at,
    updatedAt: at
  });

  // Every note lives in exactly one notebook. Older workspaces (and backups
  // made before notebooks existed) get a default notebook on first load.
  const resolveWorkspace = (incomingNotes, incomingNotebooks) => {
    const seen = new Set();
    let notebooks = (Array.isArray(incomingNotebooks) ? incomingNotebooks : [])
      .map(normalizeNotebook)
      .filter((notebook) => {
        if (!notebook || seen.has(notebook.id)) return false;
        seen.add(notebook.id);
        return true;
      });

    if (!notebooks.length) {
      const earliest = Array.isArray(incomingNotes) && incomingNotes.length
        ? Math.min(...incomingNotes.map((note) => (Number.isFinite(note.createdAt) ? note.createdAt : Date.now())))
        : Date.now();
      notebooks = [makeNotebook('Personal', earliest)];
    }

    const notebookIds = new Set(notebooks.map((notebook) => notebook.id));
    let notesChanged = false;
    const notes = (Array.isArray(incomingNotes) ? incomingNotes : []).map((note) => {
      if (note.notebookId && notebookIds.has(note.notebookId)) return note;
      notesChanged = true;
      return { ...note, notebookId: notebooks[0].id };
    });

    return { notebooks, notes, notesChanged };
  };

  const normalizeTask = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const now = Date.now();
    const done = Boolean(raw.done);
    const priority = Object.prototype.hasOwnProperty.call(PRIORITIES, raw.priority) ? raw.priority : 'none';
    const due = typeof raw.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.due) ? raw.due : null;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
      title: typeof raw.title === 'string' ? raw.title.slice(0, 500) : '',
      done,
      priority,
      due,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
      completedAt: done ? (Number.isFinite(raw.completedAt) ? raw.completedAt : now) : null
    };
  };

  const sortNotes = (list) => {
    return [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  };

  const sortTasks = (list) => {
    return [...list].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.done) return (b.completedAt || b.updatedAt || 0) - (a.completedAt || a.updatedAt || 0);

      const pa = PRIORITY_ORDER[a.priority];
      const pb = PRIORITY_ORDER[b.priority];
      if (pa !== pb) return pa - pb;

      if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
      if (a.due && !b.due) return -1;
      if (!a.due && b.due) return 1;
      return b.createdAt - a.createdAt;
    });
  };

  /* --------------------------------------------------------------------------
   * Storage tier 2 — IndexedDB with a safety net for exotic environments.
   * Opening failures fall back to localStorage; operation errors are surfaced
   * to the user instead of silently switching stores (which could hide data).
   * ------------------------------------------------------------------------*/

  const DB = (() => {
    const DB_NAME = 'slate-db';
    const DB_VERSION = 1;
    const ROW_STORES = ['notes', 'tasks'];
    const STORES = ['notes', 'tasks', 'kv'];

    let dbPromise = null;
    let mode = 'idb';
    let fallbackReason = '';

    const lsKey = (store) => `${FALLBACK_PREFIX}${store}`;

    const localRead = (store) => {
      try {
        const raw = localStorage.getItem(lsKey(store));
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed;
      } catch (err) {
        return null;
      }
    };

    const localRows = (store) => {
      const rows = localRead(store);
      return Array.isArray(rows) ? rows : [];
    };

    const localWrite = (store, rows) => {
      localStorage.setItem(lsKey(store), JSON.stringify(rows));
    };

    const localKV = () => {
      const value = localRead('kv');
      return value && typeof value === 'object' ? value : {};
    };

    const open = () => {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        let request;
        try {
          request = window.indexedDB.open(DB_NAME, DB_VERSION);
        } catch (err) {
          reject(err);
          return;
        }

        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('notes')) {
            database.createObjectStore('notes', { keyPath: 'id' });
          }
          if (!database.objectStoreNames.contains('tasks')) {
            database.createObjectStore('tasks', { keyPath: 'id' });
          }
          if (!database.objectStoreNames.contains('kv')) {
            database.createObjectStore('kv');
          }
        };

        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => {
            try { database.close(); } catch (err) { /* noop */ }
          };
          resolve(database);
        };

        request.onerror = () => reject(request.error || new Error('Could not open the local database'));
        request.onblocked = () => reject(new Error('Another Slate tab is blocking the database. Close it and retry.'));
      });
      return dbPromise;
    };

    const idbGetAll = async (store) => {
      const database = await open();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(store, 'readonly');
        const request = tx.objectStore(store).getAll();
        request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
        request.onerror = () => reject(request.error || new Error('Read failed'));
      });
    };

    const idbPut = async (store, value) => {
      const database = await open();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(store, 'readwrite');
        tx.objectStore(store).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Write failed'));
        tx.onabort = () => reject(tx.error || new Error('Write aborted'));
      });
    };

    const idbPutMany = async (store, values) => {
      if (!values.length) return;
      const database = await open();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(store, 'readwrite');
        const objectStore = tx.objectStore(store);
        values.forEach((value) => objectStore.put(value));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Write failed'));
        tx.onabort = () => reject(tx.error || new Error('Write aborted'));
      });
    };

    const idbRemove = async (store, key) => {
      const database = await open();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Delete failed'));
        tx.onabort = () => reject(tx.error || new Error('Delete aborted'));
      });
    };

    const idbClear = async (store) => {
      const database = await open();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(store, 'readwrite');
        tx.objectStore(store).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Clear failed'));
        tx.onabort = () => reject(tx.error || new Error('Clear aborted'));
      });
    };

    const idbClearAll = async () => {
      const database = await open();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(STORES, 'readwrite');
        STORES.forEach((store) => tx.objectStore(store).clear());
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Clear failed'));
        tx.onabort = () => reject(tx.error || new Error('Clear aborted'));
      });
    };

    const idbGetKV = async (key) => {
      const database = await open();
      return new Promise((resolve, reject) => {
        const tx = database.transaction('kv', 'readonly');
        const request = tx.objectStore('kv').get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Read failed'));
      });
    };

    const idbSetKV = async (key, value) => {
      const database = await open();
      return new Promise((resolve, reject) => {
        const tx = database.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        if (value === null || value === undefined) store.delete(key);
        else store.put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Write failed'));
        tx.onabort = () => reject(tx.error || new Error('Write aborted'));
      });
    };

    const assertRowStore = (store) => {
      if (!ROW_STORES.includes(store)) throw new Error(`Unknown store: ${store}`);
    };

    return {
      get mode() { return mode; },
      get fallbackReason() { return fallbackReason; },

      async init() {
        if (!window.indexedDB) {
          mode = 'local';
          fallbackReason = 'IndexedDB is not available in this browser.';
          return mode;
        }
        try {
          await open();
          mode = 'idb';
          fallbackReason = '';
        } catch (err) {
          const recoverable = ['SecurityError', 'NotSupportedError', 'InvalidStateError', 'UnknownError'].includes(err.name);
          if (!recoverable) throw err;
          mode = 'local';
          fallbackReason = err.message || 'IndexedDB could not be opened.';
        }
        return mode;
      },

      useLocalFallback(reason) {
        mode = 'local';
        fallbackReason = reason || fallbackReason || 'Using the localStorage fallback.';
      },

      async getAll(store) {
        assertRowStore(store);
        if (mode === 'local') return localRows(store);
        return idbGetAll(store);
      },

      async put(store, value) {
        assertRowStore(store);
        if (mode === 'local') {
          const rows = localRows(store).filter((row) => row.id !== value.id);
          rows.push(value);
          localWrite(store, rows);
          return;
        }
        return idbPut(store, value);
      },

      async putMany(store, values) {
        assertRowStore(store);
        if (!values || !values.length) return;
        if (mode === 'local') {
          const incoming = new Map(values.map((row) => [row.id, row]));
          const rows = localRows(store).filter((row) => !incoming.has(row.id)).concat(values);
          localWrite(store, rows);
          return;
        }
        return idbPutMany(store, values);
      },

      async remove(store, key) {
        assertRowStore(store);
        if (mode === 'local') {
          localWrite(store, localRows(store).filter((row) => row.id !== key));
          return;
        }
        return idbRemove(store, key);
      },

      async clear(store) {
        assertRowStore(store);
        if (mode === 'local') {
          localWrite(store, []);
          return;
        }
        return idbClear(store);
      },

      async clearAll() {
        if (mode === 'local') {
          STORES.forEach((store) => {
            try { localStorage.removeItem(lsKey(store)); } catch (err) { /* noop */ }
          });
          return;
        }
        return idbClearAll();
      },

      async getKV(key, fallback = null) {
        if (mode === 'local') {
          const values = localKV();
          return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
        }
        const value = await idbGetKV(key);
        return value === undefined ? fallback : value;
      },

      async setKV(key, value) {
        if (mode === 'local') {
          const values = localKV();
          if (value === null || value === undefined) delete values[key];
          else values[key] = value;
          localWrite('kv', values);
          return;
        }
        return idbSetKV(key, value);
      }
    };
  })();

  /* --------------------------------------------------------------------------
   * File System Access helpers
   * ------------------------------------------------------------------------*/

  const supportsFolderSync = () => {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  };

  const writeTextFile = async (directory, name, text) => {
    const fileHandle = await directory.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(text);
      await writable.close();
    } catch (err) {
      try { await writable.abort(); } catch (abortErr) { /* noop */ }
      throw err;
    }
  };

  const listNoteFiles = async (directory) => {
    const notesDirectory = await directory.getDirectoryHandle('notes', { create: true });
    const names = [];
    try {
      for await (const entry of notesDirectory.values()) {
        if (entry && entry.kind === 'file' && /\.md$/i.test(entry.name)) names.push(entry.name);
      }
    } catch (err) {
      // Directory iteration is best-effort (older Chromium builds).
    }
    return { notesDirectory, names };
  };

  /* --------------------------------------------------------------------------
   * Disk sync — one-way mirror, device is the source of truth.
   * ------------------------------------------------------------------------*/

  function useDiskSync({ notes, tasks, notebooks, enabled, pushToast }) {
    const [status, setStatus] = useState('disconnected');
    const [folderName, setFolderName] = useState('');
    const [lastSync, setLastSync] = useState(null);
    const [error, setError] = useState(null);

    const directoryRef = useRef(null);
    const filesRef = useRef({});
    const timerRef = useRef(null);
    const runningRef = useRef(false);
    const pendingRef = useRef(false);
    const snapshotRef = useRef({ notes, tasks, notebooks });
    const statusRef = useRef(status);
    const toastRef = useRef(pushToast);

    toastRef.current = pushToast;
    statusRef.current = status;
    snapshotRef.current = { notes, tasks, notebooks };

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const doSync = useCallback(async (options = {}) => {
      const directory = directoryRef.current;
      if (!directory) return false;

      if (runningRef.current) {
        pendingRef.current = true;
        return false;
      }

      runningRef.current = true;
      clearTimer();
      setError(null);

      try {
        let permission = 'granted';
        try {
          permission = await directory.queryPermission({ mode: 'readwrite' });
        } catch (err) {
          permission = 'prompt';
        }

        if (permission !== 'granted') {
          setStatus('needs-permission');
          if (options.manual) {
            toastRef.current({
              tone: 'error',
              title: 'Folder permission needed',
              description: 'Click “Reconnect” in Settings to allow Slate to write to your folder again.'
            });
          }
          return false;
        }

        setStatus('syncing');
        const snapshot = snapshotRef.current;
        const currentNotes = Array.isArray(snapshot.notes) ? snapshot.notes : [];
        const currentNotebooks = Array.isArray(snapshot.notebooks) ? snapshot.notebooks : [];
        const notebookById = new Map(currentNotebooks.map((notebook) => [notebook.id, notebook]));

        // Recover the filename map if it was lost (new session, older folder).
        if (!Object.keys(filesRef.current).length) {
          try {
            const { names } = await listNoteFiles(directory);
            currentNotes.forEach((note) => {
              const suffix = `-${titleSuffix(note.id)}.md`;
              const existing = names.find((name) => name.endsWith(suffix));
              if (existing) filesRef.current[note.id] = existing;
            });
          } catch (err) { /* best effort */ }
        }

        const tasksPayload = {
          app: 'Slate',
          schemaVersion: SCHEMA_VERSION,
          appVersion: APP_VERSION,
          exportedAt: new Date().toISOString(),
          counts: {
            tasks: snapshot.tasks.length,
            completed: snapshot.tasks.filter((task) => task.done).length
          },
          tasks: snapshot.tasks
        };

        await writeTextFile(directory, 'tasks.json', JSON.stringify(tasksPayload, null, 2));

        const notebooksPayload = {
          app: 'Slate',
          schemaVersion: SCHEMA_VERSION,
          appVersion: APP_VERSION,
          exportedAt: new Date().toISOString(),
          counts: {
            notebooks: currentNotebooks.length,
            notes: currentNotes.length
          },
          notebooks: currentNotebooks
        };

        await writeTextFile(directory, 'notebooks.json', JSON.stringify(notebooksPayload, null, 2));

        const notesDirectory = await directory.getDirectoryHandle('notes', { create: true });
        const nextFiles = {};

        for (const note of currentNotes) {
          const name = noteFileName(note);
          const previous = filesRef.current[note.id];
          if (previous && previous !== name) {
            try { await notesDirectory.removeEntry(previous); } catch (err) { /* already gone */ }
          }
          await writeTextFile(notesDirectory, name, noteToMarkdown(note, {
            notebook: notebookById.get(note.notebookId) || null
          }));
          nextFiles[note.id] = name;
        }

        // Remove mirrors of deleted notes, but only files we created ourselves.
        for (const [noteId, name] of Object.entries(filesRef.current)) {
          if (!nextFiles[noteId]) {
            try { await notesDirectory.removeEntry(name); } catch (err) { /* already gone */ }
          }
        }

        filesRef.current = nextFiles;
        const stamp = Date.now();

        try {
          await DB.setKV('syncFiles', nextFiles);
          await DB.setKV('syncLast', stamp);
          await DB.setKV('syncDir', directory);
        } catch (err) {
          console.warn('[slate] Could not persist folder handle:', err);
        }

        setLastSync(stamp);
        setStatus('synced');
        return true;
      } catch (err) {
        const message = (err && err.message) || 'Unknown file system error';
        setError(message);
        setStatus('error');
        if (!options.silent) {
          toastRef.current({
            tone: 'error',
            title: 'Could not write to your folder',
            description: err && err.name === 'NotAllowedError'
              ? 'Folder permission was revoked. Reconnect the folder to resume.'
              : message
          });
        }
        return false;
      } finally {
        runningRef.current = false;
        if (pendingRef.current) {
          pendingRef.current = false;
          setTimeout(() => { doSync({ silent: true }); }, 300);
        }
      }
    }, []);

    const schedule = useCallback((delay = 1200) => {
      if (!directoryRef.current) return;
      clearTimer();
      timerRef.current = setTimeout(() => { doSync({ silent: true }); }, delay);
    }, [doSync]);

    // Restore a previously connected folder.
    useEffect(() => {
      let alive = true;
      (async () => {
        try {
          const directory = await DB.getKV('syncDir', null);
          const storedFiles = await DB.getKV('syncFiles', {});
          const storedLast = await DB.getKV('syncLast', null);
          if (!alive || !directory || typeof directory.queryPermission !== 'function') return;

          directoryRef.current = directory;
          filesRef.current = storedFiles && typeof storedFiles === 'object' ? storedFiles : {};
          setFolderName(directory.name || 'Selected folder');
          setLastSync(storedLast || null);

          let permission = 'prompt';
          try {
            permission = await directory.queryPermission({ mode: 'readwrite' });
          } catch (err) {
            permission = 'prompt';
          }
          if (!alive) return;
          setStatus(permission === 'granted' ? 'ready' : 'needs-permission');
        } catch (err) {
          console.warn('[slate] Could not restore folder connection:', err);
        }
      })();
      return () => { alive = false; };
    }, []);

    // Auto-mirror after any data change (debounced).
    useEffect(() => {
      if (!enabled || !directoryRef.current) return undefined;
      const current = statusRef.current;
      if (!['ready', 'synced', 'error', 'syncing'].includes(current)) return undefined;
      schedule(1400);
      return () => clearTimer();
    }, [notes, tasks, notebooks, enabled, schedule]);

    // A freshly restored/reconnected folder catches up once it becomes ready.
    useEffect(() => {
      if (!enabled || status !== 'ready' || !directoryRef.current) return undefined;
      schedule(500);
      return () => clearTimer();
    }, [status, enabled, schedule]);

    useEffect(() => () => clearTimer(), []);

    const connect = useCallback(async () => {
      if (!supportsFolderSync()) {
        toastRef.current({
          tone: 'error',
          title: 'Folder sync isn’t supported here',
          description: 'Use Microsoft Edge or Google Chrome on Windows to connect a local folder.'
        });
        return false;
      }

      try {
        const directory = await window.showDirectoryPicker({
          id: 'slate-sync',
          mode: 'readwrite',
          startIn: 'documents'
        });

        try {
          const permission = await directory.requestPermission({ mode: 'readwrite' });
          if (permission !== 'granted') {
            toastRef.current({ tone: 'error', title: 'Permission denied', description: 'Slate needs write access to mirror your notes.' });
            return false;
          }
        } catch (err) {
          // Some Chromium builds grant implicitly after picking.
        }

        directoryRef.current = directory;
        filesRef.current = {};
        setFolderName(directory.name || 'Selected folder');
        setError(null);
        setStatus('ready');

        try {
          await DB.setKV('syncDir', directory);
          await DB.setKV('syncFiles', {});
        } catch (err) {
          console.warn('[slate] Folder handle could not be saved:', err);
          toastRef.current({
            tone: 'info',
            title: 'Folder connected for this session',
            description: 'Your browser could not remember the folder. Reconnect it after a restart.'
          });
        }

        toastRef.current({
          tone: 'success',
          title: 'Local folder connected',
          description: `Notes and tasks now mirror to “${directory.name}”.`
        });
        return true;
      } catch (err) {
        if (err && err.name === 'AbortError') return false;
        setStatus('error');
        setError((err && err.message) || 'Could not open the folder picker.');
        toastRef.current({
          tone: 'error',
          title: 'Could not connect folder',
          description: (err && err.message) || 'Try choosing a different folder.'
        });
        return false;
      }
    }, []);

    const reconnect = useCallback(async () => {
      const directory = directoryRef.current;
      if (!directory) return connect();
      try {
        const permission = await directory.requestPermission({ mode: 'readwrite' });
        if (permission !== 'granted') {
          toastRef.current({ tone: 'error', title: 'Permission denied', description: 'Slate cannot write to the folder without your approval.' });
          return false;
        }
        setError(null);
        setStatus('ready');
        toastRef.current({ tone: 'success', title: 'Folder reconnected', duration: 2500 });
        return true;
      } catch (err) {
        if (err && err.name !== 'AbortError') {
          toastRef.current({ tone: 'error', title: 'Reconnect failed', description: (err && err.message) || 'Choose the folder again in Settings.' });
        }
        return false;
      }
    }, [connect]);

    const syncNow = useCallback(async () => {
      if (!directoryRef.current) {
        toastRef.current({
          tone: 'info',
          title: 'No folder connected',
          description: 'Connect a local folder in Settings to mirror your data to disk.'
        });
        return false;
      }
      const ok = await doSync({ manual: true });
      if (ok) {
        toastRef.current({ tone: 'success', title: 'Synced to disk', description: 'tasks.json, notebooks.json and your Markdown notes are up to date.', duration: 2500 });
      }
      return ok;
    }, [doSync]);

    const disconnect = useCallback(async () => {
      clearTimer();
      directoryRef.current = null;
      filesRef.current = {};
      setFolderName('');
      setLastSync(null);
      setError(null);
      setStatus('disconnected');
      try {
        await DB.setKV('syncDir', null);
        await DB.setKV('syncFiles', null);
      } catch (err) { /* noop */ }
      toastRef.current({
        tone: 'info',
        title: 'Local folder disconnected',
        description: 'Files already written to disk were left untouched.'
      });
    }, []);

    return {
      status,
      folderName,
      lastSync,
      error,
      supported: supportsFolderSync(),
      connected: Boolean(folderName) && status !== 'disconnected',
      connect,
      reconnect,
      disconnect,
      syncNow
    };
  }

  /* --------------------------------------------------------------------------
   * UI hooks
   * ------------------------------------------------------------------------*/

  function useMediaQuery(query) {
    const read = () => {
      try { return window.matchMedia(query).matches; } catch (err) { return false; }
    };
    const [matches, setMatches] = useState(read);

    useEffect(() => {
      let media;
      try { media = window.matchMedia(query); } catch (err) { return undefined; }
      const onChange = (event) => setMatches(event.matches);
      setMatches(media.matches);
      if (media.addEventListener) media.addEventListener('change', onChange);
      else if (media.addListener) media.addListener(onChange);
      return () => {
        if (media.removeEventListener) media.removeEventListener('change', onChange);
        else if (media.removeListener) media.removeListener(onChange);
      };
    }, [query]);

    return matches;
  }

  function useToasts() {
    const [toasts, setToasts] = useState([]);
    const timers = useRef(new Map());

    const dismiss = useCallback((id) => {
      setToasts((list) => list.filter((toast) => toast.id !== id));
      const timer = timers.current.get(id);
      if (timer) {
        clearTimeout(timer);
        timers.current.delete(id);
      }
    }, []);

    const push = useCallback((toast) => {
      const id = uid();
      const tone = toast.tone || 'info';
      const duration = toast.duration === undefined ? (tone === 'error' ? 8000 : 4500) : toast.duration;
      setToasts((list) => [...list.slice(-3), { ...toast, id, tone }]);
      if (duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration);
        timers.current.set(id, timer);
      }
      return id;
    }, [dismiss]);

    useEffect(() => () => {
      timers.current.forEach((timer) => clearTimeout(timer));
      timers.current.clear();
    }, []);

    return { toasts, push, dismiss };
  }

  const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

  /* --------------------------------------------------------------------------
   * First-run content
   * ------------------------------------------------------------------------*/

  const makeSeed = () => {
    const now = Date.now();
    const today = toDayKey(new Date());
    const tomorrow = toDayKey(addDays(new Date(), 1));

    const personal = makeNotebook('Personal', now - 4000);
    const readingBook = makeNotebook('Reading', now - 3000);

    const welcome = {
      id: uid(),
      title: 'Welcome to Slate',
      pinned: true,
      notebookId: personal.id,
      createdAt: now - 1000,
      updatedAt: now - 1000,
      body: [
        'A quiet space for your tasks and notes. Everything lives on this device first — no account, no tracking, no cloud.',
        '',
        '## The basics',
        '- Press **Ctrl + N** to start a new note.',
        '- Press **Ctrl + Enter** to jump to the task composer.',
        '- Press **Ctrl + K** to search notes, **Ctrl + S** to force a save.',
        '- Use the **Rich / Source / Preview** switch above the note to format visually, edit Markdown directly, or read the rendered result.',
        '',
        '## Notebooks',
        'Notes live inside notebooks. Use the notebook list on the left to collapse a group, add a note to it, or rename it. Move a note any time with the notebook selector above its title.',
        '',
        '## Your data, your disk',
        'Open **Settings → Local folder** and connect a folder. Slate mirrors every change as:',
        '',
        '- `tasks.json` — all tasks in a single file',
        '- `notebooks.json` — your notebooks',
        '- `notes/*.md` — one Markdown file per note',
        '',
        '> Keep the folder inside OneDrive or Dropbox for a free, portable version history.',
        '',
        'When you are offline, everything keeps working. Changes sync back to disk as soon as the folder is available again.',
        '',
        '## Formatting',
        'Use the toolbar above the note body for **bold**, _italic_, ~~strikethrough~~, `inline code`, headings, bulleted and numbered lists, checklists, quotes, code blocks, links and dividers. **Ctrl + B** and **Ctrl + I** work too. Under the hood every note is still Markdown — **Source** shows the raw text and **Preview** renders it.',
        '',
        '- [x] Install Slate as a desktop app',
        '- [ ] Connect a local folder',
        '- [ ] Make it yours'
      ].join('\n')
    };

    const reading = {
      id: uid(),
      title: 'Reading list',
      pinned: false,
      notebookId: readingBook.id,
      createdAt: now - 2000,
      updatedAt: now - 2000,
      body: [
        '## On attention',
        '- *Deep Work* — Cal Newport',
        '- *The Shallows* — Nicholas Carr',
        '- *Four Thousand Weeks* — Oliver Burkeman',
        '',
        '## Marginalia',
        '> “The ability to concentrate on a single task is becoming rare, and therefore more valuable.”',
        '',
        'A place to keep the ideas worth returning to.'
      ].join('\n')
    };

    const tasks = [
      {
        id: uid(),
        title: 'Try the keyboard shortcuts',
        done: false,
        priority: 'high',
        due: today,
        createdAt: now - 500,
        updatedAt: now - 500,
        completedAt: null
      },
      {
        id: uid(),
        title: 'Connect a local folder for disk backups',
        done: false,
        priority: 'medium',
        due: tomorrow,
        createdAt: now - 400,
        updatedAt: now - 400,
        completedAt: null
      },
      {
        id: uid(),
        title: 'Install Slate as a Windows desktop app',
        done: false,
        priority: 'low',
        due: null,
        createdAt: now - 300,
        updatedAt: now - 300,
        completedAt: null
      }
    ];

    return { notes: [welcome, reading], tasks, notebooks: [personal, readingBook] };
  };

  /* --------------------------------------------------------------------------
   * Icons — hand-drawn inline strokes, no icon dependency.
   * ------------------------------------------------------------------------*/

  const ICON_PATHS = {
    check: <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    x: <><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" /></>,
    moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z" />,
    monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
    sliders: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="7" cy="17" r="2" /></>,
    trash: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" /><path d="M9 7V4h6v3" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></>,
    pin: <><path d="M9 4h6l-.8 5.2 3.3 3.3V15H6.5v-2.5l3.3-3.3L9 4Z" /><path d="M12 15v5" /></>,
    more: <><circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" /></>,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 20h16" /></>,
    upload: <><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 20h16" /></>,
    folder: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-10Z" />,
    refresh: <><path d="M20 11a8 8 0 1 0-2.3 6.7" /><path d="M20 5v6h-6" /></>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 5H6a2 2 0 0 0-2 2v9" /></>,
    fileText: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
    external: <><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>,
    keyboard: <><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" /></>,
    sparkles: <><path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" /></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
    alert: <><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 9v5M12 17h.01" /></>,
    listChecks: <><path d="M4 6.5 6 8.5 9 5" /><path d="M4 17.5 6 19.5 9 16" /><path d="M12 7h8M12 18h8" /></>,
    list: <><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none" /><circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none" /></>,
    listOrdered: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M3.5 5h1v4M3.5 9h2" /><path d="M3.5 13.2c0-.5.4-.9 1-.9s1 .4 1 .9c0 .7-.5 1-1 1.5l-1 1h2" /><path d="M3.4 20c1.1 0 2-.5 2-1.5 0-.8-.6-1.2-1.3-1.2.7 0 1.1-.4 1.1-1.1 0-.9-.8-1.2-1.8-1.2" /></>,
    quote: <><path d="M9.5 7H5v5h4.5c0 2-1.1 3.2-2.7 4.2" /><path d="M19 7h-4.5v5H19c0 2-1.1 3.2-2.7 4.2" /></>,
    code: <><path d="m9 8-4 4 4 4" /><path d="m15 8 4 4-4 4" /></>,
    codeBlock: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m9.5 10-2 2 2 2M14.5 10l2 2-2 2" /></>,
    link: <><path d="M10.5 13.5a4.5 4.5 0 0 0 6.4.1l2-2a4.5 4.5 0 0 0-6.4-6.4l-1.1 1.1" /><path d="M13.5 10.5a4.5 4.5 0 0 0-6.4-.1l-2 2a4.5 4.5 0 0 0 6.4 6.4l1.1-1.1" /></>,
    minus: <path d="M4 12h16" />,
    layout: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    notes: <><path d="M5 4h11l3 3v13H5V4Z" /><path d="M8 9h8M8 13h8M8 17h5" /></>,
    cloudOff: <><path d="M3 3l18 18" /><path d="M7 7.5A5 5 0 0 1 17 10a3.5 3.5 0 0 1 3 5" /><path d="M17 19H7a4 4 0 0 1-.6-8" /></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    hardDrive: <><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M5 13l2-8h10l2 8" /><path d="M7 16.5h.01M11 16.5h.01" /></>,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
    pencil: <><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" /><path d="m14.5 6.5 3 3" /></>,
    chevronLeft: <path d="M15 5l-7 7 7 7" />,
    chevronDown: <path d="m6 9 6 6 6-6" />,
    chevronRight: <path d="m9 6 6 6-6 6" />,
    folderPlus: <><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-10Z" /><path d="M12 11v5M9.5 13.5h5" /></>,
    flag: <><path d="M5 21V4" /><path d="M5 4h10l-1.5 4L15 12H5" /></>
  };

  function Icon({ name, size = 16, strokeWidth = 1.7, className = '' }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
        focusable="false"
      >
        {ICON_PATHS[name] || null}
      </svg>
    );
  }

  function Kbd({ children, className = '' }) {
    return (
      <kbd className={cx(
        'inline-flex h-5 min-w-[20px] items-center justify-center rounded-[5px] border border-line/10 bg-panel px-1.5 font-sans text-[11px] font-medium text-muted shadow-[0_1px_0_rgb(var(--line)/0.04)]',
        className
      )}>
        {children}
      </kbd>
    );
  }

  const BUTTON_VARIANTS = {
    primary: 'bg-accent text-white hover:opacity-90 dark:text-[#0b0c0e]',
    ghost: 'border border-line/10 bg-panel text-ink hover:bg-raised',
    subtle: 'text-muted hover:bg-line/5 hover:text-ink',
    danger: 'border border-rose-500/20 bg-rose-500/10 text-rose-600 hover:bg-rose-500/15 dark:text-rose-300'
  };

  function Btn({ variant = 'ghost', className = '', children, type = 'button', ...rest }) {
    return (
      <button
        type={type}
        className={cx(
          'inline-flex select-none items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13.2px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          BUTTON_VARIANTS[variant],
          className
        )}
        {...rest}
      >
        {children}
      </button>
    );
  }

  function IconButton({ label, icon, size = 16, className = '', buttonRef, ...rest }) {
    return (
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={label}
        className={cx(
          'grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-line/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-40',
          className
        )}
        {...rest}
      >
        <Icon name={icon} size={size} />
      </button>
    );
  }

  function Segmented({ value, options, onChange, className = '', ariaLabel }) {
    return (
      <div role="tablist" aria-label={ariaLabel} className={cx('inline-flex items-center gap-0.5 rounded-lg bg-line/[0.045] p-0.5', className)}>
        {options.map((option) => {
          const active = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(option.value)}
              className={cx(
                'inline-flex items-center gap-1.5 rounded-[7px] px-2 py-1 text-[12.65px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                active ? 'bg-panel text-ink shadow-sm' : 'text-muted hover:text-ink'
              )}
            >
              {option.icon ? <Icon name={option.icon} size={12} /> : null}
              {option.label ? <span>{option.label}</span> : null}
            </button>
          );
        })}
      </div>
    );
  }

  /* --------------------------------------------------------------------------
   * Toasts
   * ------------------------------------------------------------------------*/

  function Toaster({ toasts, onDismiss }) {
    return (
      <div
        className="pointer-events-none fixed inset-x-0 bottom-10 z-[90] flex flex-col items-center gap-2 px-4"
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => {
          const dot = toast.tone === 'error' ? 'bg-rose-500' : toast.tone === 'success' ? 'bg-emerald-500' : 'bg-accent';
          return (
            <div
              key={toast.id}
              className="pointer-events-auto flex w-full max-w-[400px] items-start gap-3 rounded-xl border border-line/10 bg-panel/95 px-3.5 py-3 shadow-pop backdrop-blur-md animate-toast-in"
            >
              <span className={cx('mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
              <div className="min-w-0 flex-1">
                <div className="text-[13.75px] font-medium leading-5 text-ink">{toast.title}</div>
                {toast.description ? (
                  <div className="mt-0.5 text-[12.65px] leading-relaxed text-muted">{toast.description}</div>
                ) : null}
              </div>
              {toast.action ? (
                <button
                  type="button"
                  onClick={() => { toast.action.onClick(); onDismiss(toast.id); }}
                  className="mt-0.5 shrink-0 rounded-md px-1.5 py-1 text-[12.65px] font-semibold text-accent hover:bg-accent/10"
                >
                  {toast.action.label}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onDismiss(toast.id)}
                aria-label="Dismiss notification"
                className="-mr-1 -mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted/70 transition-colors hover:bg-line/5 hover:text-ink"
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          );
        })}
      </div>
    );
  }

  /* --------------------------------------------------------------------------
   * Modal shell with focus trap + Escape handling
   * ------------------------------------------------------------------------*/

  function Modal({ title, description, onClose, children, footer, width = 'max-w-[540px]', icon = null }) {
    const panelRef = useRef(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
      const previous = document.activeElement;
      const panel = panelRef.current;
      if (!panel) return undefined;

      const focusables = () => Array.from(
        panel.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
      ).filter((element) => element.offsetParent !== null);

      const timer = setTimeout(() => {
        const preferred = panel.querySelector('[data-autofocus]') || focusables()[0];
        if (preferred) preferred.focus();
      }, 30);

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          event.preventDefault();
          onCloseRef.current();
          return;
        }
        if (event.key !== 'Tab') return;
        const items = focusables();
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };

      document.addEventListener('keydown', onKeyDown, true);
      return () => {
        clearTimeout(timer);
        document.removeEventListener('keydown', onKeyDown, true);
        if (previous && typeof previous.focus === 'function') previous.focus();
      };
    }, []);

    return (
      <div
        className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-0 backdrop-blur-[2px] animate-fade-in sm:items-center sm:p-6"
        onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-title"
          className={cx(
            'flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-line/10 bg-panel shadow-pop animate-fade-up sm:rounded-2xl',
            width
          )}
        >
          <div className="flex items-start gap-3 border-b border-line/8 px-5 py-4">
            {icon ? (
              <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line/10 bg-raised text-muted">
                <Icon name={icon} size={15} />
              </div>
            ) : null}
            <div className="min-w-0 flex-1">
              <h2 id="modal-title" className="text-[15.4px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
              {description ? <p className="mt-1 text-[13.2px] leading-relaxed text-muted">{description}</p> : null}
            </div>
            <IconButton label="Close" icon="x" size={15} onClick={onClose} className="-mr-1.5 -mt-1" />
          </div>
          <div className="scroll-thin overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="border-t border-line/8 bg-raised/40 px-5 py-3">{footer}</div> : null}
        </div>
      </div>
    );
  }

  /* --------------------------------------------------------------------------
   * Settings
   * ------------------------------------------------------------------------*/

  const SYNC_STATES = {
    disconnected: { label: 'Not connected', dot: 'bg-line/30', tone: 'text-muted' },
    'needs-permission': { label: 'Permission needed', dot: 'bg-amber-500', tone: 'text-amber-700 dark:text-amber-300' },
    ready: { label: 'Ready to sync', dot: 'bg-emerald-500', tone: 'text-muted' },
    syncing: { label: 'Syncing…', dot: 'bg-accent animate-pulse', tone: 'text-muted' },
    synced: { label: 'Up to date', dot: 'bg-emerald-500', tone: 'text-muted' },
    error: { label: 'Sync error', dot: 'bg-rose-500', tone: 'text-rose-600 dark:text-rose-300' }
  };

  const THEME_OPTIONS = [
    { value: 'system', label: 'System', icon: 'monitor' },
    { value: 'light', label: 'Light', icon: 'sun' },
    { value: 'dark', label: 'Dark', icon: 'moon' }
  ];

  function SettingsSection({ title, description, children }) {
    return (
      <section className="space-y-3">
        <div>
          <h3 className="text-[11.55px] font-semibold uppercase tracking-[0.13em] text-muted">{title}</h3>
          {description ? <p className="mt-1 text-[12.65px] leading-relaxed text-muted">{description}</p> : null}
        </div>
        {children}
      </section>
    );
  }

  function SettingsDialog({
    onClose,
    theme,
    onThemeChange,
    sync,
    isStandalone,
    canInstall,
    onInstall,
    online,
    noteCount,
    notebookCount,
    taskCount,
    storageUsage,
    onExport,
    onImport,
    onClearData,
    onShowShortcuts
  }) {
    const importRef = useRef(null);
    const syncState = SYNC_STATES[sync.status] || SYNC_STATES.disconnected;

    return (
      <Modal
        title="Settings"
        description="Private by default. Everything is stored on this device."
        icon="sliders"
        onClose={onClose}
        width="max-w-[560px]"
        footer={
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onShowShortcuts}
              className="inline-flex items-center gap-1.5 rounded-md text-[12.65px] text-muted transition-colors hover:text-ink"
            >
              <Icon name="keyboard" size={13} /> Keyboard shortcuts
            </button>
            <span className="text-[11.55px] text-muted">Slate v{APP_VERSION}</span>
          </div>
        }
      >
        <div className="space-y-6">
          <SettingsSection title="Appearance" description="Pick a theme, or follow Windows.">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-[13.75px] text-ink">
                <Icon name="sun" size={14} className="text-muted" /> Theme
              </div>
              <Segmented
                value={theme}
                onChange={onThemeChange}
                options={THEME_OPTIONS}
                ariaLabel="Theme"
                className="border border-line/8 bg-panel"
              />
            </div>
          </SettingsSection>

          <div className="h-px bg-line/8" />

          <SettingsSection
            title="Local folder"
            description="Mirror notebooks, notes and tasks to a folder on your PC. Slate writes tasks.json, notebooks.json, plus one Markdown file per note."
          >
            <div className="rounded-xl border border-line/8 bg-raised/50 p-3">
              <div className="flex items-start gap-3">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line/8 bg-panel text-muted">
                  <Icon name="folder" size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.75px] font-medium text-ink">
                    {sync.folderName || 'No folder connected'}
                  </div>
                  <div className={cx('mt-0.5 flex items-center gap-1.5 text-[12.1px]', syncState.tone)}>
                    <span className={cx('h-1.5 w-1.5 rounded-full', syncState.dot)} />
                    <span>{syncState.label}</span>
                    {sync.lastSync && sync.status === 'synced' ? (
                      <span className="text-muted">· {formatRelative(sync.lastSync)}</span>
                    ) : null}
                  </div>
                  {sync.error && sync.status === 'error' ? (
                    <p className="mt-1.5 text-[12.1px] leading-relaxed text-rose-600 dark:text-rose-300">{sync.error}</p>
                  ) : null}
                </div>
              </div>

              {!sync.supported ? (
                <p className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-2.5 py-2 text-[12.1px] leading-relaxed text-amber-800 dark:text-amber-200">
                  Folder sync requires Microsoft Edge or Google Chrome on Windows. You can still export a JSON backup below.
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {!sync.connected ? (
                  <Btn variant="primary" onClick={sync.connect} disabled={!sync.supported}>
                    <Icon name="folder" size={13} />
                    Connect folder
                  </Btn>
                ) : null}

                {sync.connected && sync.status === 'needs-permission' ? (
                  <Btn variant="primary" onClick={sync.reconnect}>
                    <Icon name="lock" size={13} />
                    Reconnect
                  </Btn>
                ) : null}

                {sync.connected && sync.status !== 'needs-permission' ? (
                  <Btn variant="ghost" onClick={sync.syncNow} disabled={sync.status === 'syncing'}>
                    <Icon name="refresh" size={13} className={sync.status === 'syncing' ? 'animate-spin' : ''} />
                    Sync now
                  </Btn>
                ) : null}

                {sync.connected ? (
                  <>
                    <Btn variant="subtle" onClick={sync.connect}>Change folder</Btn>
                    <Btn variant="subtle" onClick={sync.disconnect}>Disconnect</Btn>
                  </>
                ) : null}
              </div>
            </div>
            <p className="text-[11.55px] leading-relaxed text-muted">
              One-way mirror: this device is the source of truth. Removing files from disk never deletes your local data.
            </p>
          </SettingsSection>

          <div className="h-px bg-line/8" />

          <SettingsSection title="Backup & data" description="A single JSON file containing every notebook, note and task. Keep it wherever you like.">
            <div className="flex flex-wrap gap-1.5">
              <Btn variant="ghost" onClick={onExport}>
                <Icon name="download" size={13} /> Export backup
              </Btn>
              <Btn variant="ghost" onClick={() => importRef.current && importRef.current.click()}>
                <Icon name="upload" size={13} /> Import backup
              </Btn>
              <input
                ref={importRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files && event.target.files[0];
                  if (file) onImport(file);
                  event.target.value = '';
                }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.1px] text-muted">
              <span className="inline-flex items-center gap-1.5"><Icon name="database" size={12} /> IndexedDB</span>
              <span>{notebookCount} {notebookCount === 1 ? 'notebook' : 'notebooks'}</span>
              <span>{noteCount} notes</span>
              <span>{taskCount} tasks</span>
              <span>{formatBytes(storageUsage)} used</span>
            </div>
          </SettingsSection>

          <div className="h-px bg-line/8" />

          <SettingsSection title="App">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className={cx('flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.55px] font-medium',
                  online ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300')}>
                  <span className={cx('h-1.5 w-1.5 rounded-full', online ? 'bg-emerald-500' : 'bg-amber-500')} />
                  {online ? 'Offline-ready' : 'Working offline'}
                </span>
                <span className="flex items-center gap-1 text-[11.55px] text-muted">
                  <Icon name="lock" size={11} /> Local only
                </span>
              </div>
              {isStandalone ? (
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-line/10 bg-raised px-2.5 py-1.5 text-[12.65px] font-medium text-muted">
                  <Icon name="check" size={12} /> Installed
                </span>
              ) : (
                <Btn variant="ghost" onClick={onInstall}>
                  <Icon name="download" size={13} /> {canInstall ? 'Install Slate' : 'How to install'}
                </Btn>
              )}
            </div>
          </SettingsSection>

          <div className="h-px bg-line/8" />

          <SettingsSection title="Danger zone">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/15 bg-rose-500/[0.04] p-3">
              <div className="min-w-0">
                <div className="text-[13.2px] font-medium text-ink">Clear all local data</div>
                <div className="mt-0.5 text-[11.55px] leading-relaxed text-muted">Notebooks, notes, tasks, preferences and the folder connection.</div>
              </div>
              <Btn variant="danger" onClick={onClearData}>
                <Icon name="trash" size={13} /> Clear data
              </Btn>
            </div>
          </SettingsSection>
        </div>
      </Modal>
    );
  }

  /* --------------------------------------------------------------------------
   * Keyboard shortcuts + confirmation
   * ------------------------------------------------------------------------*/

  const SHORTCUTS = [
    { label: 'New note', keys: ['Ctrl', 'N'] },
    { label: 'New task', keys: ['Ctrl', 'Enter'] },
    { label: 'Search notes', keys: ['Ctrl', 'K'] },
    { label: 'Save and sync', keys: ['Ctrl', 'S'] },
    { label: 'Cycle editor view', keys: ['Ctrl', 'E'] },
    { label: 'Switch view', keys: ['Ctrl', '1', '2', '3'] },
    { label: 'Show shortcuts', keys: ['?'] },
    { label: 'Close dialog', keys: ['Esc'] }
  ];

  function ShortcutsDialog({ onClose }) {
    return (
      <Modal
        title="Keyboard shortcuts"
        description="Everything important is one keystroke away."
        icon="keyboard"
        onClose={onClose}
        width="max-w-[440px]"
        footer={<span className="text-[11.55px] text-muted">Shortcuts work from anywhere in Slate.</span>}
      >
        <ul className="divide-y divide-line/8">
          {SHORTCUTS.map((shortcut) => (
            <li key={shortcut.label} className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
              <span className="text-[13.75px] text-ink">{shortcut.label}</span>
              <span className="flex items-center gap-1">
                {shortcut.keys.map((key) => <Kbd key={key}>{key}</Kbd>)}
              </span>
            </li>
          ))}
        </ul>
      </Modal>
    );
  }

  function NotebookDialog({ mode, notebook, onClose, onSubmit }) {
    const [name, setName] = useState(notebook ? notebook.name : '');
    const trimmed = name.trim();
    const valid = trimmed.length > 0;

    const commit = () => {
      if (!valid) return;
      onSubmit(trimmed);
    };

    return (
      <Modal
        title={mode === 'rename' ? 'Rename notebook' : 'New notebook'}
        description={mode === 'rename'
          ? 'The name changes everywhere. Notes stay exactly where they are.'
          : 'Group related notes together. You can move notes between notebooks at any time.'}
        icon={mode === 'rename' ? 'pencil' : 'folderPlus'}
        onClose={onClose}
        width="max-w-[420px]"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Btn variant="subtle" onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" type="submit" form="slate-notebook-form" disabled={!valid}>
              {mode === 'rename' ? 'Save name' : 'Create notebook'}
            </Btn>
          </div>
        }
      >
        <form
          id="slate-notebook-form"
          onSubmit={(event) => { event.preventDefault(); commit(); }}
        >
          <label htmlFor="slate-notebook-name" className="mb-1.5 block text-[12.1px] font-medium text-muted">
            Notebook name
          </label>
          <input
            id="slate-notebook-name"
            data-autofocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder="e.g. Projects"
            autoComplete="off"
            spellCheck="false"
            className="h-9 w-full rounded-lg border border-line/10 bg-panel px-3 text-[14.3px] text-ink outline-none transition focus:border-accent/30 focus:ring-2 focus:ring-accent/[0.08] placeholder:text-muted/50"
          />
          <p className="mt-2 text-[11.55px] leading-relaxed text-muted">
            Every note belongs to one notebook. Use the selector above a note’s title to move it.
          </p>
        </form>
      </Modal>
    );
  }

  function ConfirmDialog({ config, onClose }) {
    return (
      <Modal
        title={config.title}
        icon={config.danger ? 'alert' : 'sparkles'}
        description={config.description}
        onClose={onClose}
        width="max-w-[420px]"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Btn variant="subtle" onClick={onClose}>Cancel</Btn>
            <Btn
              variant={config.danger ? 'danger' : 'primary'}
              data-autofocus
              onClick={() => { config.onConfirm(); onClose(); }}
            >
              {config.confirmLabel || 'Confirm'}
            </Btn>
          </div>
        }
      >
        {config.body ? <p className="text-[13.75px] leading-relaxed text-muted">{config.body}</p> : null}
      </Modal>
    );
  }

  function FatalScreen({ message, onReload, onContinue }) {
    return (
      <div className="grid h-full place-items-center bg-app px-6">
        <div className="w-full max-w-[380px] text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-line/10 bg-panel text-muted shadow-soft">
            <Icon name="alert" size={20} />
          </div>
          <h1 className="mt-5 text-[17.6px] font-semibold tracking-[-0.015em]">Couldn’t open your workspace</h1>
          <p className="mt-2 text-[13.75px] leading-relaxed text-muted">{message || 'Your local database could not be read.'}</p>
          <div className="mt-5 flex items-center justify-center gap-2">
            <Btn variant="primary" onClick={onReload}>Reload</Btn>
            <Btn variant="subtle" onClick={onContinue}>Continue with empty workspace</Btn>
          </div>
        </div>
      </div>
    );
  }

  /* --------------------------------------------------------------------------
   * Popover plumbing
   * ------------------------------------------------------------------------*/

  function useDismiss() {
    const anchorRef = useRef(null);
    const popoverRef = useRef(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
      if (!open) return undefined;
      const onPointerDown = (event) => {
        const target = event.target;
        if (popoverRef.current && popoverRef.current.contains(target)) return;
        if (anchorRef.current && anchorRef.current.contains(target)) return;
        setOpen(false);
      };
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          setOpen(false);
        }
      };
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      return () => {
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
      };
    }, [open]);

    return { anchorRef, popoverRef, open, setOpen };
  }

  /* --------------------------------------------------------------------------
   * Priority selector
   * ------------------------------------------------------------------------*/

  const PRIORITY_MENU_WIDTH = 152;
  const PRIORITY_MENU_HEIGHT = 128;

  function PriorityControl({ value, onChange }) {
    const { anchorRef, popoverRef, open, setOpen } = useDismiss();
    const [position, setPosition] = useState(null);
    const meta = PRIORITIES[value] || PRIORITIES.none;
    const isSet = value && value !== 'none';

    // The menu is rendered in a portal so it is never clipped by the scrolling
    // task list. Track the trigger while the menu is open.
    useEffect(() => {
      if (!open) return undefined;
      const place = () => {
        const anchor = anchorRef.current;
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        const below = rect.bottom + 4;
        const above = rect.top - PRIORITY_MENU_HEIGHT - 4;
        const top = below + PRIORITY_MENU_HEIGHT > window.innerHeight - 8 && above > 8 ? above : below;
        const left = clamp(rect.left, 8, Math.max(8, window.innerWidth - PRIORITY_MENU_WIDTH - 8));
        setPosition({ top: Math.round(top), left: Math.round(left) });
      };
      place();
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
      return () => {
        window.removeEventListener('scroll', place, true);
        window.removeEventListener('resize', place);
      };
    }, [open, anchorRef]);

    const menu = open && position ? ReactDOM.createPortal(
      <div
        ref={popoverRef}
        role="menu"
        aria-label="Set priority"
        style={{ position: 'fixed', top: position.top, left: position.left, width: PRIORITY_MENU_WIDTH }}
        className="z-[70] animate-pop-in rounded-lg border border-line/10 bg-panel p-1 shadow-pop"
      >
        {['high', 'medium', 'low', 'none'].map((key) => (
          <button
            key={key}
            type="button"
            role="menuitemradio"
            aria-checked={value === key}
            onClick={() => { onChange(key); setOpen(false); }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.65px] text-ink transition-colors hover:bg-line/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <span className={cx('h-1.5 w-1.5 rounded-full', PRIORITIES[key].dot)} />
            <span className="flex-1">{PRIORITIES[key].label}</span>
            {value === key ? <Icon name="check" size={11} className="text-accent" /> : null}
          </button>
        ))}
      </div>,
      document.body
    ) : null;

    return (
      <>
        <div className="inline-flex">
          <button
            ref={anchorRef}
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-haspopup="menu"
            aria-expanded={open}
            title={`Priority: ${meta.label}`}
            className={cx(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-[3px] text-[11.55px] leading-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              isSet ? cx('border', meta.chip, 'hover:brightness-95') : 'text-muted/70 hover:bg-line/5 hover:text-ink'
            )}
          >
            {isSet ? <span className={cx('h-1.5 w-1.5 rounded-full', meta.dot)} /> : <Icon name="flag" size={11} />}
            {isSet ? <span>{meta.label}</span> : null}
          </button>
        </div>
        {menu}
      </>
    );
  }

  /* --------------------------------------------------------------------------
   * Due date control
   * ------------------------------------------------------------------------*/

  function DueControl({ due, onChange }) {
    const inputRef = useRef(null);
    const info = dueInfo(due);

    const openPicker = () => {
      const input = inputRef.current;
      if (!input) return;
      try {
        if (typeof input.showPicker === 'function') input.showPicker();
        else input.focus();
      } catch (err) {
        try { input.focus(); } catch (focusErr) { /* noop */ }
      }
    };

    const tone = !info
      ? 'text-muted/70 hover:bg-line/5 hover:text-ink'
      : info.tone === 'overdue'
        ? 'border border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-300'
        : info.tone === 'today'
          ? 'border border-accent/20 bg-accent/[0.07] text-accent'
          : 'border border-line/10 bg-line/[0.03] text-muted hover:text-ink';

    return (
      <div className="relative inline-flex items-center">
        <button
          type="button"
          onClick={openPicker}
          title={due ? `Due ${due}` : 'Set a due date'}
          className={cx(
            'inline-flex items-center gap-1 rounded-md px-1.5 py-[3px] text-[11.55px] leading-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            tone
          )}
        >
          <Icon name="calendar" size={11} />
          {info ? <span>{info.label}</span> : null}
        </button>

        {due ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label="Clear due date"
            title="Clear due date"
            className="ml-0.5 grid h-[18px] w-[18px] place-items-center rounded text-muted/60 transition-colors hover:bg-line/5 hover:text-ink"
          >
            <Icon name="x" size={9} />
          </button>
        ) : null}

        <input
          ref={inputRef}
          type="date"
          value={due || ''}
          onChange={(event) => onChange(event.target.value || null)}
          aria-label="Due date"
          tabIndex={-1}
          className="date-overlay pointer-events-none absolute left-0 top-0 h-full w-6 opacity-0"
        />
      </div>
    );
  }

  /* --------------------------------------------------------------------------
   * Task composer
   * ------------------------------------------------------------------------*/

  function TaskComposer({ onAdd, inputRef, formRef }) {
    const [title, setTitle] = useState('');
    const [priority, setPriority] = useState('none');
    const [due, setDue] = useState(null);
    const [expanded, setExpanded] = useState(false);

    const hasDetails = priority !== 'none' || Boolean(due);

    const submit = (event) => {
      if (event) event.preventDefault();
      const trimmed = title.trim();
      if (!trimmed) {
        if (inputRef.current) inputRef.current.focus();
        return;
      }
      onAdd({ title: trimmed, priority, due });
      setTitle('');
      setPriority('none');
      setDue(null);
      if (inputRef.current) inputRef.current.focus();
    };

    const onBlur = (event) => {
      if (!event.currentTarget.contains(event.relatedTarget) && !title.trim() && !hasDetails) {
        setExpanded(false);
      }
    };

    return (
      <form
        ref={formRef}
        onSubmit={submit}
        onBlur={onBlur}
        className={cx(
          'rounded-xl border border-line/10 bg-panel shadow-soft transition-shadow duration-200',
          'focus-within:border-accent/25 focus-within:ring-2 focus-within:ring-accent/[0.07]'
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <Icon name="plus" size={15} className="shrink-0 text-muted/60" />
          <input
            ref={inputRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onFocus={() => setExpanded(true)}
            placeholder="Add a task…"
            aria-label="New task title"
            autoComplete="off"
            spellCheck="false"
            className="min-w-0 flex-1 bg-transparent py-0.5 text-[14.3px] leading-5 text-ink outline-none placeholder:text-muted/60"
          />
          <span className="hidden items-center gap-1 lg:flex" aria-hidden="true">
            <Kbd>Ctrl</Kbd>
            <Kbd>↵</Kbd>
          </span>
          <button
            type="submit"
            disabled={!title.trim()}
            className={cx(
              'rounded-md px-2 py-1 text-[12.1px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              title.trim()
                ? 'bg-accent text-white hover:opacity-90 dark:text-[#0b0c0e]'
                : 'cursor-default text-muted/40'
            )}
          >
            Add
          </button>
        </div>

        {expanded ? (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-line/8 px-2.5 py-1.5 animate-fade-in">
            <PriorityControl value={priority} onChange={setPriority} />
            <DueControl due={due} onChange={setDue} />
            <span className="ml-auto hidden select-none text-[11px] text-muted/60 sm:block">
              {title.trim() ? 'Enter to add' : 'Details are optional'}
            </span>
          </div>
        ) : null}
      </form>
    );
  }

  /* --------------------------------------------------------------------------
   * Task row
   * ------------------------------------------------------------------------*/

  function TaskItem({ task, onToggle, onUpdate, onDelete }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(task.title);
    const inputRef = useRef(null);

    useEffect(() => { setDraft(task.title); }, [task.title]);
    useEffect(() => {
      if (!editing) return;
      const frame = requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      });
      return () => cancelAnimationFrame(frame);
    }, [editing]);

    const commit = () => {
      const next = draft.trim();
      setEditing(false);
      if (!next) { setDraft(task.title); return; }
      setDraft(next);
      if (next !== task.title) onUpdate(task.id, { title: next });
    };

    return (
      <li className={cx(
        'group relative flex items-start gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-line/[0.03]',
        task.done && 'opacity-65'
      )}>
        <button
          type="button"
          role="checkbox"
          aria-checked={task.done}
          aria-label={task.done ? `Mark “${task.title}” as active` : `Complete “${task.title}”`}
          onClick={() => onToggle(task.id)}
          className={cx(
            'mt-[1px] grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[6px] border transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            task.done
              ? 'border-accent bg-accent text-white dark:text-[#0b0c0e]'
              : 'border-line/20 bg-panel text-transparent hover:border-accent/50 hover:bg-accent/[0.06]'
          )}
        >
          {task.done ? <Icon name="check" size={11} strokeWidth={2.6} className="animate-check-in" /> : null}
        </button>

        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); commit(); }
                if (event.key === 'Escape') { event.preventDefault(); setDraft(task.title); setEditing(false); }
              }}
              className="w-full rounded-md border border-accent/30 bg-panel px-1.5 py-0.5 text-[14.3px] leading-5 text-ink outline-none ring-2 ring-accent/[0.08]"
              aria-label="Task title"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="Click to edit"
              className={cx(
                'block w-full overflow-hidden text-left text-[14.3px] leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]',
                task.done ? 'text-muted line-through decoration-line/30' : 'text-ink'
              )}
            >
              {task.title || 'Untitled task'}
            </button>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-1">
            <PriorityControl value={task.priority} onChange={(priority) => onUpdate(task.id, { priority })} />
            <DueControl due={task.due} onChange={(due) => onUpdate(task.id, { due })} />
            {task.done && task.completedAt ? (
              <span className="px-1 text-[11px] text-muted/70">Completed {formatRelative(task.completedAt)}</span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100">
          <IconButton
            label="Delete task"
            icon="trash"
            size={14}
            onClick={() => onDelete(task)}
            className="h-7 w-7 hover:text-rose-600 dark:hover:text-rose-300"
          />
        </div>
      </li>
    );
  }

  /* --------------------------------------------------------------------------
   * Task panel
   * ------------------------------------------------------------------------*/

  function TaskPanel({
    tasks,
    visibleTasks,
    filter,
    counts,
    solo,
    onFilterChange,
    onAdd,
    onToggle,
    onUpdate,
    onDelete,
    onClearCompleted,
    inputRef,
    formRef
  }) {
    const total = counts.all || 0;
    const percent = total ? Math.round((counts.done / total) * 100) : 0;
    const contentWidth = solo ? 'mx-auto w-full max-w-[760px]' : '';

    const emptyCopy = {
      all: {
        title: 'A clear slate',
        body: 'Add your first task above. Press Ctrl + Enter from anywhere to jump back here.'
      },
      active: {
        title: 'Nothing open',
        body: 'Every task is done. Add something new, or take the rest of the day off.'
      },
      done: {
        title: 'Nothing completed yet',
        body: 'Checked tasks collect here so you can see what you have moved forward.'
      }
    }[filter] || { title: 'No tasks', body: 'Add a task above to get started.' };

    return (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel" aria-label="Tasks">
        <div className="shrink-0 px-4 pt-4 sm:px-5">
          <div className={contentWidth}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h1 className="text-[16.5px] font-semibold tracking-[-0.015em] text-ink">Tasks</h1>
                <p className="mt-0.5 text-[12.1px] text-muted">
                  {counts.active} open · {counts.done} done
                </p>
              </div>
              <span className="mt-1 select-none text-[11px] uppercase tracking-[0.16em] text-muted/60">
                {new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
              </span>
            </div>
            <TaskComposer onAdd={onAdd} inputRef={inputRef} formRef={formRef} />
          </div>
        </div>

        <div className="shrink-0 px-4 pt-3 sm:px-5">
          <div className={cx('flex items-center justify-between gap-2', contentWidth)}>
            <Segmented
              value={filter}
              onChange={onFilterChange}
              options={[
                { value: 'all', label: 'All' },
                { value: 'active', label: 'Active' },
                { value: 'done', label: 'Completed' }
              ]}
              ariaLabel="Filter tasks"
            />
            {counts.done > 0 ? (
              <button
                type="button"
                onClick={onClearCompleted}
                className="rounded-md px-1.5 py-1 text-[11.55px] text-muted transition-colors hover:bg-line/5 hover:text-ink"
              >
                Clear completed
              </button>
            ) : null}
          </div>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2 sm:px-3">
          <ul className={cx('space-y-0.5', solo && 'mx-auto max-w-[760px]')}>
            {visibleTasks.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                onToggle={onToggle}
                onUpdate={onUpdate}
                onDelete={onDelete}
              />
            ))}
          </ul>

          {visibleTasks.length === 0 ? (
            <div className="flex h-full min-h-[220px] flex-col items-center justify-center px-6 pb-6 text-center">
              <div className="grid h-11 w-11 place-items-center rounded-2xl border border-line/10 bg-raised text-muted/70">
                <Icon name={filter === 'done' ? 'check' : 'listChecks'} size={18} />
              </div>
              <p className="mt-3 text-[13.75px] font-medium text-ink">{emptyCopy.title}</p>
              <p className="mt-1 max-w-[260px] text-[12.65px] leading-relaxed text-muted">{emptyCopy.body}</p>
            </div>
          ) : null}
        </div>

        <div className="shrink-0 border-t border-line/8 px-4 py-2.5 sm:px-5">
          <div className={cx('flex items-center gap-3', contentWidth)}>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-line/[0.07]">
              <div
                className="h-full rounded-full bg-accent/70 transition-[width] duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="w-8 text-right text-[11.55px] tabular-nums text-muted">{percent}%</span>
          </div>
        </div>
      </section>
    );
  }

  /* --------------------------------------------------------------------------
   * Notes
   * ------------------------------------------------------------------------*/

  function NoteListItem({ note, active, onSelect, onDelete }) {
    return (
      <div className={cx(
        'group relative rounded-lg transition-colors',
        active ? 'bg-panel shadow-soft ring-1 ring-line/[0.05]' : 'hover:bg-line/[0.04]'
      )}>
        <button
          type="button"
          onClick={onSelect}
          className="block w-full px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/30"
        >
          <div className="flex items-center gap-1.5 pr-6">
            {note.pinned ? <Icon name="pin" size={10} className="shrink-0 text-muted" /> : null}
            <span className={cx('truncate text-[13.75px] leading-4', active ? 'font-semibold text-ink' : 'font-medium text-ink')}>
              {noteTitle(note)}
            </span>
          </div>
          <p className="mt-1 truncate text-[12.1px] leading-4 text-muted">{noteExcerpt(note)}</p>
          <div className="mt-1 text-[11px] text-muted/70">{formatRelative(note.updatedAt)}</div>
        </button>

        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onDelete(note); }}
          aria-label={`Delete ${noteTitle(note)}`}
          title="Delete note"
          className="absolute right-1.5 top-2 grid h-6 w-6 place-items-center rounded-md text-muted/60 opacity-0 transition-all hover:bg-line/5 hover:text-rose-600 focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100"
        >
          <Icon name="trash" size={12} />
        </button>
      </div>
    );
  }

  function EditorTool({ label, hint, active, onClick, children }) {
    return (
      <button
        type="button"
        title={hint ? `${label} (${hint})` : label}
        aria-label={label}
        aria-pressed={active === undefined ? undefined : Boolean(active)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        className={cx(
          'grid h-[26px] min-w-[26px] place-items-center rounded-[6px] px-1.5 text-[11.55px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          active
            ? 'bg-accent/10 text-accent'
            : 'text-muted hover:bg-line/8 hover:text-ink'
        )}
      >
        {children}
      </button>
    );
  }

  function RichTextEditor({ noteId, value, onChange, editorRef, placeholder }) {
    const innerRef = useRef(null);
    const valueRef = useRef(value);
    const lastValueRef = useRef(value);
    const onChangeRef = useRef(onChange);
    const composingRef = useRef(false);
    const [empty, setEmpty] = useState(() => !String(value || '').trim());
    const [format, setFormat] = useState({
      bold: false, italic: false, strike: false, ul: false, ol: false, block: ''
    });

    valueRef.current = value;
    onChangeRef.current = onChange;

    const attachRef = (element) => {
      innerRef.current = element;
      if (editorRef) editorRef.current = element;
    };

    const syncFromDom = useCallback(() => {
      const element = innerRef.current;
      if (!element) return;
      const next = editorHtmlToMarkdown(element);
      lastValueRef.current = next;
      setEmpty(!next.trim());
      if (next !== valueRef.current) onChangeRef.current(next);
    }, []);

    const refreshFormat = useCallback(() => {
      const element = innerRef.current;
      const selection = window.getSelection();
      if (!element || !selection || !selection.anchorNode || !element.contains(selection.anchorNode)) return;

      let block = '';
      let bold = false;
      let italic = false;
      let strike = false;
      let ul = false;
      let ol = false;

      try {
        block = String(document.queryCommandValue('formatBlock') || '').toLowerCase();
        bold = document.queryCommandState('bold');
        italic = document.queryCommandState('italic');
        strike = document.queryCommandState('strikeThrough');
        ul = document.queryCommandState('insertUnorderedList');
        ol = document.queryCommandState('insertOrderedList');
      } catch (err) { /* commands are best-effort */ }

      setFormat((prev) => (
        prev.block === block && prev.bold === bold && prev.italic === italic
          && prev.strike === strike && prev.ul === ul && prev.ol === ol
          ? prev
          : { block, bold, italic, strike, ul, ol }
      ));
    }, []);

    const closestTag = (node, tag) => {
      let element = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
      while (element && element !== innerRef.current) {
        if (element.tagName === tag) return element;
        element = element.parentElement;
      }
      return null;
    };

    const unwrapElement = (element) => {
      const parent = element.parentNode;
      if (!parent) return;
      while (element.firstChild) parent.insertBefore(element.firstChild, element);
      parent.removeChild(element);
      parent.normalize();
    };

    const runCommand = (command, argument) => {
      const element = innerRef.current;
      if (!element) return;
      element.focus();
      try { document.execCommand('styleWithCSS', false, false); } catch (err) { /* noop */ }
      try { document.execCommand(command, false, argument); } catch (err) { /* noop */ }
      syncFromDom();
      refreshFormat();
    };

    const toggleBlock = (tag) => {
      let current = '';
      try { current = String(document.queryCommandValue('formatBlock') || '').toLowerCase(); } catch (err) { /* noop */ }
      const wanted = tag.toLowerCase();
      const next = current === wanted ? 'p' : tag;
      const selection = window.getSelection();

      // Chrome nests formatBlock inside quotes and code blocks. Lift the caret
      // out first so the chosen block replaces the current one.
      if (selection && selection.anchorNode) {
        const nested = closestTag(selection.anchorNode, 'BLOCKQUOTE') || closestTag(selection.anchorNode, 'PRE');
        const sameType = nested && (
          (wanted === 'blockquote' && nested.tagName === 'BLOCKQUOTE')
          || (wanted === 'pre' && nested.tagName === 'PRE')
        );
        if (nested && !sameType) {
          if (nested.tagName === 'PRE') {
            const paragraph = document.createElement('p');
            paragraph.textContent = String(nested.textContent || '');
            if (nested.parentNode) nested.parentNode.replaceChild(paragraph, nested);
            const caret = document.createRange();
            caret.selectNodeContents(paragraph);
            caret.collapse(true);
            selection.removeAllRanges();
            selection.addRange(caret);
          } else {
            unwrapElement(nested);
          }
        }
      }

      runCommand('formatBlock', next);
    };

    const toggleInlineCode = () => {
      const element = innerRef.current;
      if (!element) return;
      element.focus();
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return;

      const existing = closestTag(selection.anchorNode, 'CODE');
      if (existing) {
        unwrapElement(existing);
        syncFromDom();
        return;
      }

      const range = selection.getRangeAt(0);
      if (range.collapsed) {
        const code = document.createElement('code');
        code.appendChild(document.createTextNode('\u200B'));
        range.insertNode(code);
        const caret = document.createRange();
        caret.setStart(code.firstChild, 1);
        caret.collapse(true);
        selection.removeAllRanges();
        selection.addRange(caret);
      } else {
        const code = document.createElement('code');
        code.textContent = range.toString();
        range.deleteContents();
        range.insertNode(code);
        const caret = document.createRange();
        caret.setStartAfter(code);
        caret.collapse(true);
        selection.removeAllRanges();
        selection.addRange(caret);
      }
      syncFromDom();
      refreshFormat();
    };

    const selectElement = (element) => {
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNode(element);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    const applyLink = () => {
      const element = innerRef.current;
      if (!element) return;
      element.focus();
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return;

      const anchor = closestTag(selection.anchorNode, 'A');
      const current = anchor ? (anchor.getAttribute('href') || '') : '';
      const answer = window.prompt('Link URL', current || 'https://');
      if (answer === null) return;

      const trimmed = answer.trim();
      if (!trimmed) {
        if (anchor) {
          selectElement(anchor);
          try { document.execCommand('unlink'); } catch (err) { /* noop */ }
          syncFromDom();
          refreshFormat();
        }
        return;
      }

      const href = /^(https?:\/\/|mailto:)/i.test(trimmed)
        ? trimmed
        : `https://${trimmed.replace(/^\/+/, '')}`;
      if (!safeHref(href)) return;

      if (anchor) {
        anchor.setAttribute('href', href);
      } else if (selection.isCollapsed) {
        try {
          document.execCommand('insertHTML', false, `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`);
        } catch (err) { /* noop */ }
      } else {
        try { document.execCommand('createLink', false, href); } catch (err) { /* noop */ }
      }

      syncFromDom();
      refreshFormat();
    };

    const insertChecklist = () => {
      const element = innerRef.current;
      if (!element) return;
      element.focus();

      const selection = window.getSelection();
      const item = selection && selection.anchorNode ? closestTag(selection.anchorNode, 'LI') : null;

      if (item) {
        const existing = Array.from(item.children).find((child) => child.tagName === 'INPUT' && child.type === 'checkbox');
        if (existing) {
          existing.remove();
        } else {
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.setAttribute('data-task-checkbox', 'true');
          input.setAttribute('contenteditable', 'false');
          input.setAttribute('tabindex', '-1');
          item.insertBefore(input, item.firstChild);
        }
        const list = item.parentElement;
        if (list && list.tagName === 'UL') {
          const hasTasks = Boolean(list.querySelector('li > input[type="checkbox"]'));
          list.classList.toggle('task-list', hasTasks);
        }
        syncFromDom();
        refreshFormat();
        return;
      }

      try {
        document.execCommand(
          'insertHTML',
          false,
          '<ul class="task-list"><li><input type="checkbox" data-task-checkbox="true" contenteditable="false" tabindex="-1"><span>&#8203;</span></li></ul>'
        );
      } catch (err) { /* noop */ }

      requestAnimationFrame(() => {
        const lists = element.querySelectorAll('ul.task-list');
        const list = lists[lists.length - 1];
        const span = list ? list.querySelector('li > span') : null;
        if (span) {
          const range = document.createRange();
          range.selectNodeContents(span);
          range.collapse(true);
          const active = window.getSelection();
          active.removeAllRanges();
          active.addRange(range);
        }
        syncFromDom();
        refreshFormat();
      });
    };

    const handlePaste = (event) => {
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const html = clipboard.getData('text/html');
      if (!html) return;

      event.preventDefault();
      const clean = sanitizePastedHtml(html);
      const element = innerRef.current;
      if (!element) return;
      element.focus();
      try {
        if (clean) document.execCommand('insertHTML', false, clean);
        else document.execCommand('insertText', false, clipboard.getData('text/plain') || '');
      } catch (err) { /* noop */ }
      syncFromDom();
    };

    const handleClick = (event) => {
      const target = event.target;
      if (target && target.tagName === 'INPUT' && target.type === 'checkbox') {
        requestAnimationFrame(() => {
          target.setAttribute('aria-label', target.checked ? 'Completed task' : 'Incomplete task');
          syncFromDom();
        });
        return;
      }
      if (target && typeof target.closest === 'function' && target.closest('a')) {
        if (!event.ctrlKey && !event.metaKey) event.preventDefault();
      }
    };

    const handleKeyDown = (event) => {
      const mod = event.ctrlKey || event.metaKey;

      if (mod && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        runCommand('bold');
        return;
      }
      if (mod && !event.altKey && event.key.toLowerCase() === 'i') {
        event.preventDefault();
        runCommand('italic');
        return;
      }
      if (mod && event.key.toLowerCase() === 'u') {
        event.preventDefault();
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        runCommand('insertText', '  ');
      }
    };

    useLayoutEffect(() => {
      const element = innerRef.current;
      if (!element) return;
      element.innerHTML = markdownToEditorHtml(valueRef.current);
      lastValueRef.current = valueRef.current;
      setEmpty(!String(valueRef.current || '').trim());
    }, [noteId]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element) return;
      if (value === lastValueRef.current) return;
      if (document.activeElement === element) return;
      element.innerHTML = markdownToEditorHtml(value);
      lastValueRef.current = value;
      setEmpty(!String(value || '').trim());
    }, [value]);

    useEffect(() => {
      let frame = 0;
      const schedule = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          refreshFormat();
        });
      };
      document.addEventListener('selectionchange', schedule);
      return () => {
        document.removeEventListener('selectionchange', schedule);
        if (frame) cancelAnimationFrame(frame);
      };
    }, [refreshFormat]);

    return (
      <div>
        <div
          role="toolbar"
          aria-label="Text formatting"
          className="mb-2.5 flex flex-wrap items-center gap-0.5 rounded-lg border border-line/8 bg-line/[0.02] px-1 py-1"
        >
          <EditorTool label="Bold" hint="Ctrl+B" active={format.bold} onClick={() => runCommand('bold')}>
            <span className="font-bold">B</span>
          </EditorTool>
          <EditorTool label="Italic" hint="Ctrl+I" active={format.italic} onClick={() => runCommand('italic')}>
            <span className="italic">I</span>
          </EditorTool>
          <EditorTool label="Strikethrough" active={format.strike} onClick={() => runCommand('strikeThrough')}>
            <span className="line-through">S</span>
          </EditorTool>
          <EditorTool label="Inline code" onClick={toggleInlineCode}>
            <Icon name="code" size={13} />
          </EditorTool>

          <span className="mx-1 h-4 w-px bg-line/10" aria-hidden="true" />

          <EditorTool label="Heading 1" active={format.block === 'h1'} onClick={() => toggleBlock('h1')}>H1</EditorTool>
          <EditorTool label="Heading 2" active={format.block === 'h2'} onClick={() => toggleBlock('h2')}>H2</EditorTool>
          <EditorTool label="Heading 3" active={format.block === 'h3'} onClick={() => toggleBlock('h3')}>H3</EditorTool>

          <span className="mx-1 h-4 w-px bg-line/10" aria-hidden="true" />

          <EditorTool label="Bulleted list" active={format.ul} onClick={() => runCommand('insertUnorderedList')}>
            <Icon name="list" size={14} />
          </EditorTool>
          <EditorTool label="Numbered list" active={format.ol} onClick={() => runCommand('insertOrderedList')}>
            <Icon name="listOrdered" size={14} />
          </EditorTool>
          <EditorTool label="Checklist" onClick={insertChecklist}>
            <Icon name="listChecks" size={13} />
          </EditorTool>
          <EditorTool label="Quote" active={format.block === 'blockquote'} onClick={() => toggleBlock('blockquote')}>
            <Icon name="quote" size={13} />
          </EditorTool>
          <EditorTool label="Code block" active={format.block === 'pre'} onClick={() => toggleBlock('pre')}>
            <Icon name="codeBlock" size={14} />
          </EditorTool>

          <span className="mx-1 h-4 w-px bg-line/10" aria-hidden="true" />

          <EditorTool label="Insert link" onClick={applyLink}>
            <Icon name="link" size={13} />
          </EditorTool>
          <EditorTool label="Divider" onClick={() => runCommand('insertHorizontalRule')}>
            <Icon name="minus" size={14} />
          </EditorTool>
        </div>

        <div className="relative">
          <div
            ref={attachRef}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label="Note body"
            aria-placeholder={placeholder}
            spellCheck
            className="md rich-editor block w-full text-[15.95px] leading-7 text-ink/90"
            onInput={() => { if (!composingRef.current) syncFromDom(); }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onClick={handleClick}
            onBlur={syncFromDom}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; syncFromDom(); }}
          />
          {empty ? (
            <p
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 m-0 text-[15.95px] leading-7 text-muted/40"
            >
              {placeholder}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  function NoteEditor({
    note,
    notebooks,
    editorMode,
    onEditorModeChange,
    onUpdate,
    onDelete,
    onPin,
    onCopy,
    onExport,
    onNew,
    onBack,
    onMoveNotebook,
    titleInputRef
  }) {
    const bodyRef = useRef(null);

    const wrapSelection = (prefix, suffix) => {
      const element = bodyRef.current;
      if (!element) return;
      const start = element.selectionStart;
      const end = element.selectionEnd;
      const selected = note.body.slice(start, end);
      const next = note.body.slice(0, start) + prefix + selected + suffix + note.body.slice(end);
      onUpdate(note.id, { body: next });
      requestAnimationFrame(() => {
        element.focus();
        const cursorStart = start + prefix.length;
        element.selectionStart = cursorStart;
        element.selectionEnd = cursorStart + selected.length;
      });
    };

    const onBodyKeyDown = (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        wrapSelection('**', '**');
        return;
      }
      if (mod && event.key.toLowerCase() === 'i') {
        event.preventDefault();
        wrapSelection('_', '_');
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const element = event.currentTarget;
        const start = element.selectionStart;
        const end = element.selectionEnd;
        const next = note.body.slice(0, start) + '  ' + note.body.slice(end);
        onUpdate(note.id, { body: next });
        requestAnimationFrame(() => {
          element.selectionStart = start + 2;
          element.selectionEnd = start + 2;
        });
      }
    };

    if (!note) {
      return (
        <div className="flex h-full flex-col items-center justify-center px-8 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-2xl border border-line/10 bg-raised text-muted/70">
            <Icon name="notes" size={20} />
          </div>
          <p className="mt-4 text-[14.3px] font-medium text-ink">Nothing selected</p>
          <p className="mt-1 max-w-[280px] text-[12.65px] leading-relaxed text-muted">
            Choose a note from the list, or start a new one. Everything saves automatically.
          </p>
          <Btn variant="primary" className="mt-4" onClick={onNew}>
            <Icon name="plus" size={13} /> New note
          </Btn>
        </div>
      );
    }

    const words = wordCount(note.body);

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line/8 px-3 sm:px-4">
          <IconButton
            label="Back to notes"
            icon="chevronLeft"
            size={16}
            onClick={onBack}
            className="-ml-1 sm:hidden"
          />

          <Segmented
            value={editorMode}
            onChange={onEditorModeChange}
            options={[
              { value: 'rich', label: 'Rich', icon: 'pencil' },
              { value: 'markdown', label: 'Source', icon: 'code' },
              { value: 'preview', label: 'Preview', icon: 'eye' }
            ]}
            ariaLabel="Editor mode"
          />
          <span className="ml-1 hidden text-[11.55px] text-muted lg:block">
            {editorMode === 'preview' ? 'Read mode' : editorMode === 'markdown' ? 'Markdown source' : 'Rich text'}
          </span>

          <div className="ml-auto flex items-center gap-0.5">
            <IconButton
              label={note.pinned ? 'Unpin note' : 'Pin note'}
              icon="pin"
              aria-pressed={note.pinned}
              onClick={() => onPin(note)}
              className={note.pinned ? 'bg-accent/10 text-accent hover:bg-accent/15 hover:text-accent' : ''}
            />
            <IconButton label="Copy Markdown" icon="copy" onClick={() => onCopy(note)} className="max-sm:hidden" />
            <IconButton label="Export note as Markdown" icon="download" onClick={() => onExport(note)} className="max-sm:hidden" />
            <IconButton label="Delete note" icon="trash" onClick={() => onDelete(note)} className="hover:text-rose-600 dark:hover:text-rose-300" />
          </div>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[740px] px-5 pb-20 pt-6 sm:px-9 sm:pt-8">
            <div className="mb-2.5 flex flex-wrap items-center gap-2">
              <div className="relative inline-flex items-center">
                <Icon name="folder" size={11} className="pointer-events-none absolute left-2 text-muted/70" />
                <select
                  value={note.notebookId || ''}
                  onChange={(event) => onMoveNotebook(note.id, event.target.value)}
                  aria-label="Move note to notebook"
                  title="Move note to notebook"
                  className="h-7 max-w-[200px] appearance-none rounded-md border border-line/10 bg-app pl-7 pr-6 text-[11.55px] font-medium text-muted outline-none transition hover:text-ink focus:border-accent/30 focus:ring-2 focus:ring-accent/[0.08]"
                >
                  {notebooks.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
                <Icon name="chevronDown" size={10} className="pointer-events-none absolute right-1.5 text-muted/70" />
              </div>
            </div>

            <input
              ref={titleInputRef}
              data-note-title
              value={note.title}
              onChange={(event) => onUpdate(note.id, { title: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  const element = bodyRef.current;
                  if (!element) return;
                  element.focus();
                  if (editorMode === 'rich') {
                    const range = document.createRange();
                    range.selectNodeContents(element);
                    range.collapse(false);
                    const selection = window.getSelection();
                    if (selection) {
                      selection.removeAllRanges();
                      selection.addRange(range);
                    }
                  }
                }
              }}
              placeholder="Untitled note"
              aria-label="Note title"
              autoComplete="off"
              spellCheck="false"
              className="w-full bg-transparent text-[26.4px] font-semibold leading-[1.2] tracking-[-0.02em] text-ink outline-none placeholder:text-muted/30 sm:text-[29.7px]"
            />

            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.55px] text-muted/80">
              <span>Edited {formatRelative(note.updatedAt)}</span>
              <span className="text-muted/35">·</span>
              <span>{words} {words === 1 ? 'word' : 'words'}</span>
              <span className="text-muted/35">·</span>
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/80" />
                Autosaved
              </span>
            </div>

            <div className="mt-6">
              {editorMode === 'preview' ? (
                note.body.trim() ? (
                  <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(note.body) }} />
                ) : (
                  <p className="text-[14.3px] italic text-muted/70">
                    Nothing to preview yet. Switch to Rich text and start typing.
                  </p>
                )
              ) : editorMode === 'markdown' ? (
                <textarea
                  ref={bodyRef}
                  value={note.body}
                  onChange={(event) => onUpdate(note.id, { body: event.target.value })}
                  onKeyDown={onBodyKeyDown}
                  placeholder="Write Markdown here — headings, lists, quotes, links, and code."
                  aria-label="Note body"
                  spellCheck
                  className="block min-h-[46vh] w-full resize-none overflow-hidden bg-transparent text-[15.95px] leading-7 text-ink/90 outline-none placeholder:text-muted/40"
                />
              ) : (
                <RichTextEditor
                  noteId={note.id}
                  value={note.body}
                  onChange={(next) => onUpdate(note.id, { body: next })}
                  editorRef={bodyRef}
                  placeholder="Start writing… Use the toolbar or shortcuts to add structure."
                />
              )}
            </div>

            {editorMode !== 'preview' ? (
              <div className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line/8 pt-3 text-[11px] text-muted/60">
                {editorMode === 'rich' ? (
                  <>
                    <span className="inline-flex items-center gap-1"><Kbd>Ctrl</Kbd><Kbd>B</Kbd> bold</span>
                    <span className="inline-flex items-center gap-1"><Kbd>Ctrl</Kbd><Kbd>I</Kbd> italic</span>
                    <span className="inline-flex items-center gap-1"><Kbd>Ctrl</Kbd><Kbd>E</Kbd> change view</span>
                  </>
                ) : (
                  <>
                    <span>Markdown source</span>
                    <span className="inline-flex items-center gap-1"><Kbd>Ctrl</Kbd><Kbd>B</Kbd> bold</span>
                    <span className="inline-flex items-center gap-1"><Kbd>Ctrl</Kbd><Kbd>I</Kbd> italic</span>
                  </>
                )}
                <span className="ml-auto hidden sm:inline">Autosaves as you type</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  function NotebookAction({ label, icon, onClick, danger = false }) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        className={cx(
          'grid h-5 w-5 place-items-center rounded text-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
          danger
            ? 'hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-300'
            : 'hover:bg-line/8 hover:text-ink'
        )}
      >
        <Icon name={icon} size={11} />
      </button>
    );
  }

  function NotesPanel({
    notes,
    filteredNotes,
    notebookGroups,
    notebooks,
    collapsedNotebooks,
    activeNotebookId,
    query,
    onQueryChange,
    activeNoteId,
    activeNote,
    onSelect,
    onNew,
    onDelete,
    onUpdate,
    onPin,
    onCopy,
    onExport,
    onToggleNotebook,
    onCreateNotebook,
    onRenameNotebook,
    onDeleteNotebook,
    onMoveNotebook,
    editorMode,
    onEditorModeChange,
    searchRef,
    titleInputRef,
    newNoteSignal
  }) {
    const [mobileEditor, setMobileEditor] = useState(false);

    useEffect(() => {
      if (newNoteSignal > 0) setMobileEditor(true);
    }, [newNoteSignal]);

    useEffect(() => {
      if (!activeNote) setMobileEditor(false);
    }, [activeNote]);

    const selectNote = (id) => {
      onSelect(id);
      setMobileEditor(true);
    };

    return (
      <section className="flex min-h-0 min-w-0 flex-1 bg-panel" aria-label="Notes">
        <div className={cx(
          'flex w-full shrink-0 flex-col border-r border-line/8 bg-app sm:w-[264px] xl:w-[292px]',
          mobileEditor ? 'hidden sm:flex' : 'flex'
        )}>
          <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
            <div className="flex items-baseline gap-2">
              <h1 className="text-[16.5px] font-semibold tracking-[-0.015em] text-ink">Notes</h1>
              <span className="text-[11.55px] tabular-nums text-muted">{notes.length}</span>
            </div>
            <div className="flex items-center gap-0.5">
              <IconButton label="New notebook" icon="folderPlus" onClick={onCreateNotebook} />
              <IconButton label="New note (Ctrl+N)" icon="plus" onClick={() => onNew(activeNotebookId)} />
            </div>
          </div>

          <div className="px-3 pb-3">
            <div className="relative">
              <Icon
                name="search"
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted/60"
              />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="Search notes…"
                aria-label="Search notes"
                autoComplete="off"
                spellCheck="false"
                className="h-8 w-full rounded-lg border border-line/10 bg-panel pl-8 pr-14 text-[13.2px] text-ink outline-none transition focus:border-accent/25 focus:ring-2 focus:ring-accent/[0.07] placeholder:text-muted/50"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => onQueryChange('')}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-muted hover:bg-line/5 hover:text-ink"
                >
                  <Icon name="x" size={11} />
                </button>
              ) : (
                <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2">
                  <Kbd>Ctrl K</Kbd>
                </span>
              )}
            </div>
          </div>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {query && filteredNotes.length === 0 ? (
              <div className="flex flex-col items-center px-3 py-10 text-center">
                <div className="grid h-9 w-9 place-items-center rounded-xl border border-line/10 bg-panel text-muted/60">
                  <Icon name="search" size={15} />
                </div>
                <p className="mt-3 text-[13.2px] font-medium text-ink">No matches</p>
                <p className="mt-1 max-w-[190px] text-[12.1px] leading-relaxed text-muted">
                  Nothing matches “{query.trim()}”. Try a different phrase.
                </p>
                <Btn variant="subtle" className="mt-3" onClick={() => onQueryChange('')}>
                  Clear search
                </Btn>
              </div>
            ) : notebookGroups.length === 0 ? (
              <div className="flex flex-col items-center px-3 py-10 text-center">
                <div className="grid h-9 w-9 place-items-center rounded-xl border border-line/10 bg-panel text-muted/60">
                  <Icon name="folderPlus" size={15} />
                </div>
                <p className="mt-3 text-[13.2px] font-medium text-ink">No notebooks yet</p>
                <p className="mt-1 max-w-[190px] text-[12.1px] leading-relaxed text-muted">
                  Create a notebook to start grouping your notes.
                </p>
                <Btn variant="primary" className="mt-3" onClick={onCreateNotebook}>
                  <Icon name="folderPlus" size={12} /> New notebook
                </Btn>
              </div>
            ) : (
              <div className="pb-1">
                {notebookGroups.map((group) => {
                  const expanded = query ? true : !collapsedNotebooks.includes(group.id);
                  if (query && group.notes.length === 0) return null;
                  const isActiveNotebook = group.id === activeNotebookId;

                  return (
                    <div key={group.id} className="mb-1.5">
                      <div className="group/nb flex items-center gap-0.5 rounded-md pr-1 transition-colors hover:bg-line/[0.03]">
                        <button
                          type="button"
                          onClick={() => onToggleNotebook(group.id)}
                          aria-expanded={expanded}
                          title={expanded ? `Collapse ${group.name}` : `Expand ${group.name}`}
                          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/30"
                        >
                          <Icon
                            name={expanded ? 'chevronDown' : 'chevronRight'}
                            size={11}
                            className="shrink-0 text-muted/60"
                          />
                          <span className={cx(
                            'truncate text-[11.55px] font-semibold uppercase tracking-[0.12em]',
                            isActiveNotebook ? 'text-ink' : 'text-muted/70'
                          )}>
                            {group.name}
                          </span>
                          <span className="ml-0.5 shrink-0 text-[10.45px] tabular-nums text-muted/50">
                            {group.notes.length}
                          </span>
                        </button>

                        <div className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/nb:opacity-100 max-sm:opacity-100">
                          <NotebookAction
                            label={`New note in ${group.name}`}
                            icon="plus"
                            onClick={() => onNew(group.id)}
                          />
                          <NotebookAction
                            label={`Rename ${group.name}`}
                            icon="pencil"
                            onClick={() => onRenameNotebook(group)}
                          />
                          <NotebookAction
                            label={`Delete ${group.name}`}
                            icon="trash"
                            danger
                            onClick={() => onDeleteNotebook(group)}
                          />
                        </div>
                      </div>

                      {expanded ? (
                        group.notes.length > 0 ? (
                          <div className="ml-2.5 space-y-0.5 border-l border-line/10 pb-0.5 pl-1.5">
                            {group.notes.map((note) => (
                              <NoteListItem
                                key={note.id}
                                note={note}
                                active={note.id === activeNoteId}
                                onSelect={() => selectNote(note.id)}
                                onDelete={onDelete}
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="ml-2.5 border-l border-line/10 pl-1.5">
                            <button
                              type="button"
                              onClick={() => onNew(group.id)}
                              className="flex w-full items-center gap-1.5 rounded-md border border-dashed border-line/10 px-2 py-1.5 text-left text-[11px] text-muted/60 transition-colors hover:border-line/20 hover:text-muted"
                            >
                              <Icon name="plus" size={10} /> Add a note
                            </button>
                          </div>
                        )
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-line/8 px-4 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] text-muted/70">
              <Icon name="database" size={11} />
              <span>Autosaved on this device</span>
            </div>
          </div>
        </div>

        <div className={cx('flex min-h-0 min-w-0 flex-1 flex-col bg-panel', mobileEditor ? 'flex' : 'hidden sm:flex')}>
          <NoteEditor
            note={activeNote}
            notebooks={notebooks}
            editorMode={editorMode}
            onEditorModeChange={onEditorModeChange}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onPin={onPin}
            onCopy={onCopy}
            onExport={onExport}
            onNew={onNew}
            onBack={() => setMobileEditor(false)}
            onMoveNotebook={onMoveNotebook}
            titleInputRef={titleInputRef}
          />
        </div>
      </section>
    );
  }

  /* --------------------------------------------------------------------------
   * Boot screen shown while IndexedDB warms up
   * ------------------------------------------------------------------------*/

  function BootScreen() {
    return (
      <div className="grid h-full place-items-center bg-app">
        <div className="flex flex-col items-center">
          <div className="grid h-11 w-11 place-items-center rounded-[13px] bg-ink text-panel">
            <Icon name="check" size={22} strokeWidth={2.2} />
          </div>
          <div className="mt-4 text-[16.5px] font-semibold tracking-[-0.01em] text-ink">Slate</div>
          <div className="mt-1 text-[10.45px] uppercase tracking-[0.18em] text-muted">Opening workspace</div>
          <div className="mt-5 h-0.5 w-24 overflow-hidden rounded-full bg-line/10">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-ink/40" />
          </div>
        </div>
      </div>
    );
  }

  function Logo({ className = '' }) {
    return (
      <div className={cx(
        'grid h-7 w-7 shrink-0 place-items-center rounded-[9px] bg-ink text-panel shadow-sm',
        className
      )}>
        <Icon name="check" size={14} strokeWidth={2.4} />
      </div>
    );
  }

  /* --------------------------------------------------------------------------
   * App
   * ------------------------------------------------------------------------*/

  function App() {
    const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
    const isNarrow = useMediaQuery('(max-width: 1023px)');

    const [theme, setTheme] = useState(() => {
      const stored = Prefs.get('theme', 'system');
      return ['system', 'light', 'dark'].includes(stored) ? stored : 'system';
    });
    const [view, setView] = useState(() => {
      const stored = Prefs.get('view', 'split');
      return ['tasks', 'notes', 'split'].includes(stored) ? stored : 'split';
    });
    const [filter, setFilter] = useState(() => {
      const stored = Prefs.get('taskFilter', 'all');
      return ['all', 'active', 'done'].includes(stored) ? stored : 'all';
    });
    const [activeNoteId, setActiveNoteId] = useState(() => Prefs.get('activeNoteId', null));
    const [activeNotebookId, setActiveNotebookId] = useState(() => Prefs.get('activeNotebookId', null));
    const [collapsedNotebooks, setCollapsedNotebooks] = useState(() => {
      const stored = Prefs.get('collapsedNotebooks', []);
      return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [];
    });

    const [notes, setNotes] = useState([]);
    const [tasks, setTasks] = useState([]);
    const [notebooks, setNotebooks] = useState([]);
    const [query, setQuery] = useState('');
    const [editorMode, setEditorMode] = useState(() => {
      const stored = Prefs.get('editorMode', 'rich');
      return ['rich', 'markdown', 'preview'].includes(stored) ? stored : 'rich';
    });
    const [hydrated, setHydrated] = useState(false);
    const [loadingError, setLoadingError] = useState(null);
    const [saveState, setSaveState] = useState('saved');
    const [savedAt, setSavedAt] = useState(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [notebookDialog, setNotebookDialog] = useState(null);
    const [confirmConfig, setConfirmConfig] = useState(null);
    const [online, setOnline] = useState(() => navigator.onLine !== false);
    const [installPrompt, setInstallPrompt] = useState(null);
    const [isStandalone, setIsStandalone] = useState(() => {
      try {
        return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
      } catch (err) {
        return false;
      }
    });
    const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
    const [storageUsage, setStorageUsage] = useState(0);
    const [newNoteSignal, setNewNoteSignal] = useState(0);
    const [updateReady, setUpdateReady] = useState(false);
    const [, setClockTick] = useState(0);

    const notesRef = useRef([]);
    const tasksRef = useRef([]);
    const notebooksRef = useRef([]);
    const persistedNotesRef = useRef(new Map());
    const dirtyNotesRef = useRef(new Map());
    const noteSaveTimerRef = useRef(null);
    const searchRef = useRef(null);
    const titleInputRef = useRef(null);
    const taskInputRef = useRef(null);
    const taskFormRef = useRef(null);
    const swRegRef = useRef(null);

    const sync = useDiskSync({ notes, tasks, notebooks, enabled: hydrated, pushToast });

    /* ----------------------------- note persistence ----------------------- */

    const flushNotes = useCallback(async () => {
      if (noteSaveTimerRef.current) {
        clearTimeout(noteSaveTimerRef.current);
        noteSaveTimerRef.current = null;
      }
      const entries = Array.from(dirtyNotesRef.current.values());
      if (!entries.length) {
        setSaveState('saved');
        return;
      }

      dirtyNotesRef.current.clear();
      try {
        await DB.putMany('notes', entries);
        entries.forEach((note) => persistedNotesRef.current.set(note.id, note));
        setSavedAt(Date.now());
        setSaveState(dirtyNotesRef.current.size ? 'saving' : 'saved');
      } catch (err) {
        entries.forEach((note) => {
          if (!dirtyNotesRef.current.has(note.id)) dirtyNotesRef.current.set(note.id, note);
        });
        setSaveState('error');
        pushToast({
          tone: 'error',
          title: 'Could not save your note',
          description: (err && err.message) || 'Storage may be full. Export a backup to keep your work safe.'
        });
      }
    }, [pushToast]);

    useEffect(() => {
      if (!hydrated) return undefined;
      let changed = false;
      notes.forEach((note) => {
        if (persistedNotesRef.current.get(note.id) !== note) {
          dirtyNotesRef.current.set(note.id, note);
          changed = true;
        }
      });
      if (!changed) return undefined;

      setSaveState('saving');
      if (noteSaveTimerRef.current) clearTimeout(noteSaveTimerRef.current);
      noteSaveTimerRef.current = setTimeout(() => { flushNotes(); }, 320);
      return undefined;
    }, [notes, hydrated, flushNotes]);

    useEffect(() => {
      notesRef.current = notes;
    }, [notes]);

    useEffect(() => {
      tasksRef.current = tasks;
    }, [tasks]);

    useEffect(() => {
      notebooksRef.current = notebooks;
    }, [notebooks]);

    useEffect(() => {
      if (!hydrated) return;
      DB.setKV('notebooks', notebooks).catch((err) => {
        pushToast({
          tone: 'error',
          title: 'Could not save notebooks',
          description: (err && err.message) || 'Storage may be full. Export a backup to keep your work safe.'
        });
      });
    }, [notebooks, hydrated, pushToast]);

    // Best-effort flush if the window is closed mid-keystroke.
    useEffect(() => {
      const flush = () => {
        if (noteSaveTimerRef.current) {
          clearTimeout(noteSaveTimerRef.current);
          noteSaveTimerRef.current = null;
        }
        const entries = Array.from(dirtyNotesRef.current.values());
        dirtyNotesRef.current.clear();
        if (entries.length) DB.putMany('notes', entries).catch(() => {});
      };
      const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        window.removeEventListener('pagehide', flush);
        document.removeEventListener('visibilitychange', onVisibility);
      };
    }, []);

    /* ------------------------------- hydration ---------------------------- */

    useEffect(() => {
      let alive = true;
      (async () => {
        try {
          await DB.init();
          const [storedNotes, storedTasks, storedNotebooks, seeded] = await Promise.all([
            DB.getAll('notes'),
            DB.getAll('tasks'),
            DB.getKV('notebooks', []),
            DB.getKV('seeded', false)
          ]);

          let nextNotes = (Array.isArray(storedNotes) ? storedNotes : []).map(normalizeNote).filter(Boolean);
          let nextTasks = (Array.isArray(storedTasks) ? storedTasks : []).map(normalizeTask).filter(Boolean);
          let nextNotebooks = [];

          if (!seeded && !nextNotes.length && !nextTasks.length) {
            const seed = makeSeed();
            nextNotes = seed.notes;
            nextTasks = seed.tasks;
            nextNotebooks = seed.notebooks;
            await DB.putMany('notes', seed.notes);
            await DB.putMany('tasks', seed.tasks);
            await DB.setKV('notebooks', seed.notebooks);
            await DB.setKV('seeded', true);
          } else {
            const resolved = resolveWorkspace(nextNotes, storedNotebooks);
            nextNotes = resolved.notes;
            nextNotebooks = resolved.notebooks;
            if (resolved.notesChanged) await DB.putMany('notes', resolved.notes);
            // Persist the resolved list so defaults and migrations stick.
            await DB.setKV('notebooks', nextNotebooks);
          }

          if (!alive) return;
          const sorted = sortNotes(nextNotes);
          const preferred = Prefs.get('activeNoteId', null);
          const preferredNote = nextNotes.find((note) => note.id === preferred);
          const preferredNotebook = Prefs.get('activeNotebookId', null);
          const preferredBook = nextNotebooks.find((notebook) => notebook.id === preferredNotebook);

          notesRef.current = nextNotes;
          tasksRef.current = nextTasks;
          notebooksRef.current = nextNotebooks;
          persistedNotesRef.current = new Map(nextNotes.map((note) => [note.id, note]));

          setNotes(nextNotes);
          setTasks(nextTasks);
          setNotebooks(nextNotebooks);
          setActiveNotebookId(preferredBook ? preferredBook.id : (nextNotebooks[0] ? nextNotebooks[0].id : null));
          setActiveNoteId(preferredNote ? preferredNote.id : (sorted[0] ? sorted[0].id : null));
          setSavedAt(Date.now());
          setHydrated(true);

          if (DB.mode === 'local') {
            pushToast({
              tone: 'error',
              title: 'Using limited storage',
              description: DB.fallbackReason || 'IndexedDB is unavailable. Data is being saved to localStorage instead.',
              duration: 9000
            });
          }
        } catch (err) {
          console.error('[slate] Could not load workspace:', err);
          if (!alive) return;
          setLoadingError((err && err.message) || 'Your local database could not be read.');
        }
      })();
      return () => { alive = false; };
    }, [pushToast]);

    /* -------------------------------- theme ------------------------------- */

    useEffect(() => {
      let media;
      try { media = window.matchMedia('(prefers-color-scheme: dark)'); } catch (err) { media = null; }

      const apply = () => {
        const dark = theme === 'dark' || (theme === 'system' && Boolean(media && media.matches));
        document.documentElement.classList.toggle('dark', dark);
        document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
        setIsDark(dark);
        const meta = document.getElementById('theme-color');
        if (meta) meta.setAttribute('content', dark ? '#0a0b0d' : '#f7f7f5');
      };

      apply();
      if (theme !== 'system' || !media) return undefined;

      const onChange = () => apply();
      if (media.addEventListener) media.addEventListener('change', onChange);
      else if (media.addListener) media.addListener(onChange);
      return () => {
        if (media.removeEventListener) media.removeEventListener('change', onChange);
        else if (media.removeListener) media.removeListener(onChange);
      };
    }, [theme]);

    useEffect(() => {
      Prefs.set({ theme, view, taskFilter: filter, editorMode, activeNoteId, activeNotebookId, collapsedNotebooks });
    }, [theme, view, filter, editorMode, activeNoteId, activeNotebookId, collapsedNotebooks]);

    // Refresh relative timestamps and due labels every minute. Only the tick
    // changes, so the notes array (and its debounced persistence) is untouched.
    useEffect(() => {
      const timer = setInterval(() => {
        setClockTick((value) => value + 1);
      }, 60000);
      return () => clearInterval(timer);
    }, []);

    /* ------------------------------- note CRUD ---------------------------- */

    const updateNote = useCallback((id, patch) => {
      const current = notesRef.current.find((note) => note.id === id);
      if (!current) return;
      const next = { ...current, ...patch, updatedAt: Date.now() };
      notesRef.current = notesRef.current.map((note) => (note.id === id ? next : note));
      setNotes(notesRef.current);
    }, []);

    const createNote = useCallback((requestedNotebookId) => {
      const notebookList = notebooksRef.current;
      const requested = typeof requestedNotebookId === 'string' ? requestedNotebookId : null;
      const notebookId = requested && notebookList.some((notebook) => notebook.id === requested)
        ? requested
        : (notebookList.find((notebook) => notebook.id === activeNotebookId)
          ? activeNotebookId
          : (notebookList[0] ? notebookList[0].id : null));

      if (!notebookId) {
        pushToast({
          tone: 'info',
          title: 'Create a notebook first',
          description: 'Notes live inside notebooks. Add one from the sidebar.'
        });
        setNotebookDialog({ mode: 'create', notebook: null });
        return;
      }

      const now = Date.now();
      const note = normalizeNote({ id: uid(), title: '', body: '', createdAt: now, updatedAt: now, pinned: false, notebookId });
      notesRef.current = [note, ...notesRef.current];
      setNotes(notesRef.current);
      setActiveNoteId(note.id);
      setActiveNotebookId(notebookId);
      setCollapsedNotebooks((prev) => prev.filter((id) => id !== notebookId));
      setQuery('');
      setEditorMode('rich');
      setNewNoteSignal((value) => value + 1);
      if (isNarrow) setView('notes');
      else if (view === 'tasks') setView('split');
      window.setTimeout(() => {
        const input = titleInputRef.current;
        if (input) input.focus();
      }, 90);
    }, [activeNotebookId, isNarrow, view, pushToast]);

    const deleteNote = useCallback((note) => {
      const nextNotes = notesRef.current.filter((item) => item.id !== note.id);
      notesRef.current = nextNotes;
      setNotes(nextNotes);
      persistedNotesRef.current.delete(note.id);
      dirtyNotesRef.current.delete(note.id);

      DB.remove('notes', note.id).catch((err) => {
        pushToast({ tone: 'error', title: 'Could not delete note', description: (err && err.message) || 'Try again.' });
      });

      setActiveNoteId((current) => {
        if (current !== note.id) return current;
        const next = sortNotes(nextNotes)[0];
        return next ? next.id : null;
      });

      pushToast({
        tone: 'info',
        title: 'Note deleted',
        description: noteTitle(note),
        action: {
          label: 'Undo',
          onClick: () => {
            if (notesRef.current.some((item) => item.id === note.id)) return;
            const restored = { ...note, updatedAt: Date.now() };
            notesRef.current = [restored, ...notesRef.current];
            setNotes(notesRef.current);
            setActiveNoteId(restored.id);
            DB.put('notes', restored).catch(() => {});
            pushToast({ tone: 'success', title: 'Note restored', duration: 2200 });
          }
        }
      });
    }, [pushToast]);

    const pinNote = useCallback((note) => {
      updateNote(note.id, { pinned: !note.pinned });
    }, [updateNote]);

    const createNotebook = useCallback((name) => {
      const clean = String(name || '').trim().slice(0, 80);
      if (!clean) return false;
      if (notebooksRef.current.some((notebook) => notebook.name.toLowerCase() === clean.toLowerCase())) {
        pushToast({
          tone: 'error',
          title: 'Notebook already exists',
          description: `There is already a notebook named “${clean}”.`
        });
        return false;
      }
      const notebook = makeNotebook(clean);
      notebooksRef.current = [...notebooksRef.current, notebook];
      setNotebooks(notebooksRef.current);
      setActiveNotebookId(notebook.id);
      setCollapsedNotebooks((prev) => prev.filter((id) => id !== notebook.id));
      pushToast({ tone: 'success', title: 'Notebook created', description: notebook.name, duration: 2200 });
      return true;
    }, [pushToast]);

    const renameNotebook = useCallback((notebook, name) => {
      const clean = String(name || '').trim().slice(0, 80);
      if (!clean) return false;
      if (notebooksRef.current.some((item) => item.id !== notebook.id && item.name.toLowerCase() === clean.toLowerCase())) {
        pushToast({
          tone: 'error',
          title: 'Notebook already exists',
          description: `There is already a notebook named “${clean}”.`
        });
        return false;
      }
      const next = notebooksRef.current.map((item) => (
        item.id === notebook.id ? { ...item, name: clean, updatedAt: Date.now() } : item
      ));
      notebooksRef.current = next;
      setNotebooks(next);
      return true;
    }, [pushToast]);

    const deleteNotebook = useCallback((notebook) => {
      const remaining = notebooksRef.current.filter((item) => item.id !== notebook.id);
      if (!remaining.length) {
        pushToast({
          tone: 'info',
          title: 'Keep at least one notebook',
          description: 'Create another notebook before deleting this one.'
        });
        return;
      }

      const fallback = remaining[0];
      const noteCount = notesRef.current.filter((note) => note.notebookId === notebook.id).length;

      setConfirmConfig({
        title: `Delete “${notebook.name}”?`,
        description: 'The notebook is removed. Its notes are kept.',
        body: noteCount
          ? `${noteCount} ${noteCount === 1 ? 'note moves' : 'notes move'} to “${fallback.name}”. No notes are deleted.`
          : 'This notebook is empty, so nothing else changes.',
        confirmLabel: 'Delete notebook',
        danger: true,
        onConfirm: () => {
          const stamp = Date.now();
          const nextNotes = notesRef.current.map((note) => (
            note.notebookId === notebook.id ? { ...note, notebookId: fallback.id, updatedAt: stamp } : note
          ));
          notesRef.current = nextNotes;
          notebooksRef.current = remaining;
          setNotes(nextNotes);
          setNotebooks(remaining);
          setCollapsedNotebooks((prev) => prev.filter((id) => id !== notebook.id));
          setActiveNotebookId((current) => (current === notebook.id ? fallback.id : current));
          pushToast({
            tone: 'info',
            title: 'Notebook deleted',
            description: noteCount
              ? `${noteCount} ${noteCount === 1 ? 'note was' : 'notes were'} moved to “${fallback.name}”.`
              : notebook.name,
            duration: 2800
          });
        }
      });
    }, [pushToast]);

    const toggleNotebook = useCallback((id) => {
      setCollapsedNotebooks((prev) => (
        prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
      ));
    }, []);

    const moveNoteToNotebook = useCallback((id, notebookId) => {
      const notebook = notebooksRef.current.find((item) => item.id === notebookId);
      if (!notebook) return;
      updateNote(id, { notebookId });
      setCollapsedNotebooks((prev) => prev.filter((item) => item !== notebookId));
      pushToast({ tone: 'success', title: 'Note moved', description: notebook.name, duration: 1800 });
    }, [updateNote, pushToast]);

    const selectNote = useCallback((id) => {
      flushNotes();
      setActiveNoteId(id);
      const note = notesRef.current.find((item) => item.id === id);
      if (note && note.notebookId) {
        setActiveNotebookId(note.notebookId);
        setCollapsedNotebooks((prev) => prev.filter((item) => item !== note.notebookId));
      }
    }, [flushNotes]);

    const copyNote = useCallback(async (note) => {
      try {
        await navigator.clipboard.writeText(note.body || '');
        pushToast({ tone: 'success', title: 'Markdown copied', duration: 2200 });
      } catch (err) {
        pushToast({ tone: 'error', title: 'Could not access the clipboard', description: 'Your browser blocked clipboard access.' });
      }
    }, [pushToast]);

    const exportNote = useCallback(async (note) => {
      const content = noteToMarkdown(note, { frontmatter: false });
      const filename = `${slugify(note.title) || 'note'}.md`;
      try {
        if (window.showSaveFilePicker) {
          const handle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: 'Markdown document', accept: { 'text/markdown': ['.md'] } }]
          });
          const writable = await handle.createWritable();
          await writable.write(content);
          await writable.close();
          pushToast({ tone: 'success', title: 'Note exported', description: handle.name });
        } else {
          downloadFile(filename, content, 'text/markdown');
          pushToast({ tone: 'success', title: 'Note downloaded', description: filename });
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        pushToast({ tone: 'error', title: 'Export failed', description: (err && err.message) || 'Try again.' });
      }
    }, [pushToast]);

    /* ------------------------------- task CRUD ---------------------------- */

    const persistTask = useCallback((task) => {
      DB.put('tasks', task)
        .then(() => {
          setSavedAt(Date.now());
          setSaveState(dirtyNotesRef.current.size ? 'saving' : 'saved');
        })
        .catch((err) => {
          pushToast({
            tone: 'error',
            title: 'Could not save task',
            description: (err && err.message) || 'Storage may be full. Export a backup to keep your work safe.'
          });
        });
    }, [pushToast]);

    const addTask = useCallback(({ title, priority, due }) => {
      const task = normalizeTask({ id: uid(), title, priority, due, done: false, createdAt: Date.now(), updatedAt: Date.now() });
      tasksRef.current = [task, ...tasksRef.current];
      setTasks(tasksRef.current);
      persistTask(task);
    }, [persistTask]);

    const updateTask = useCallback((id, patch) => {
      const current = tasksRef.current.find((task) => task.id === id);
      if (!current) return;
      const next = { ...current, ...patch, updatedAt: Date.now() };
      if (Object.prototype.hasOwnProperty.call(patch, 'done')) {
        next.completedAt = patch.done ? Date.now() : null;
      }
      tasksRef.current = tasksRef.current.map((task) => (task.id === id ? next : task));
      setTasks(tasksRef.current);
      persistTask(next);
    }, [persistTask]);

    const toggleTask = useCallback((id) => {
      const task = tasksRef.current.find((item) => item.id === id);
      if (task) updateTask(id, { done: !task.done });
    }, [updateTask]);

    const deleteTask = useCallback((task) => {
      tasksRef.current = tasksRef.current.filter((item) => item.id !== task.id);
      setTasks(tasksRef.current);
      DB.remove('tasks', task.id).catch((err) => {
        pushToast({ tone: 'error', title: 'Could not delete task', description: (err && err.message) || 'Try again.' });
      });
      pushToast({
        tone: 'info',
        title: 'Task deleted',
        description: task.title,
        action: {
          label: 'Undo',
          onClick: () => {
            if (tasksRef.current.some((item) => item.id === task.id)) return;
            tasksRef.current = [...tasksRef.current, task];
            setTasks(tasksRef.current);
            DB.put('tasks', task).catch(() => {});
            pushToast({ tone: 'success', title: 'Task restored', duration: 2200 });
          }
        }
      });
    }, [pushToast]);

    const clearCompleted = useCallback(() => {
      const completed = tasksRef.current.filter((task) => task.done);
      if (!completed.length) return;
      setConfirmConfig({
        title: `Clear ${completed.length} completed ${completed.length === 1 ? 'task' : 'tasks'}?`,
        description: 'Active tasks are not affected.',
        body: 'This removes the completed tasks from this device. Your connected folder will be updated on the next sync.',
        confirmLabel: 'Clear completed',
        danger: false,
        onConfirm: () => {
          const ids = new Set(completed.map((task) => task.id));
          tasksRef.current = tasksRef.current.filter((task) => !ids.has(task.id));
          setTasks(tasksRef.current);
          ids.forEach((id) => { DB.remove('tasks', id).catch(() => {}); });
          pushToast({ tone: 'info', title: 'Completed tasks cleared', duration: 2400 });
        }
      });
    }, [pushToast]);

    /* ------------------------------ computed ------------------------------ */

    const sortedNotes = useMemo(() => sortNotes(notes), [notes]);

    const filteredNotes = useMemo(() => {
      const needle = query.trim().toLowerCase();
      if (!needle) return sortedNotes;
      return sortedNotes.filter((note) => `${note.title}\n${note.body}`.toLowerCase().includes(needle));
    }, [sortedNotes, query]);

    const notebookGroups = useMemo(() => notebooks.map((notebook) => ({
      ...notebook,
      notes: filteredNotes.filter((note) => note.notebookId === notebook.id)
    })), [notebooks, filteredNotes]);

    const activeNote = useMemo(() => notes.find((note) => note.id === activeNoteId) || null, [notes, activeNoteId]);

    const counts = useMemo(() => {
      let active = 0;
      let done = 0;
      tasks.forEach((task) => { if (task.done) done += 1; else active += 1; });
      return { all: tasks.length, active, done };
    }, [tasks]);

    const visibleTasks = useMemo(() => {
      const base = filter === 'active'
        ? tasks.filter((task) => !task.done)
        : filter === 'done'
          ? tasks.filter((task) => task.done)
          : tasks;
      return sortTasks(base);
    }, [tasks, filter]);

    const effectiveView = isNarrow && view === 'split' ? 'tasks' : view;
    const showTasks = effectiveView !== 'notes';
    const showNotes = effectiveView !== 'tasks';
    const notesVisible = isNarrow ? effectiveView === 'notes' : showNotes;

    // If the active note disappears (delete/import), land on the first note.
    useEffect(() => {
      if (!hydrated) return;
      if (activeNoteId && notes.some((note) => note.id === activeNoteId)) return;
      const next = sortNotes(notes)[0];
      setActiveNoteId(next ? next.id : null);
    }, [hydrated, activeNoteId, notes]);

    // Keep the active notebook pointing at a real notebook.
    useEffect(() => {
      if (!hydrated || !notebooks.length) return;
      if (notebooks.some((notebook) => notebook.id === activeNotebookId)) return;
      setActiveNotebookId(notebooks[0].id);
    }, [hydrated, notebooks, activeNotebookId]);

    /* ------------------------------- actions ------------------------------ */

    const focusTaskComposer = useCallback(() => {
      if (isNarrow) {
        if (view !== 'tasks') setView('tasks');
      } else if (view === 'notes') {
        setView('split');
      }
      window.setTimeout(() => {
        const input = taskInputRef.current;
        if (input) {
          input.focus();
          try { input.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (err) { /* noop */ }
        }
      }, 80);
    }, [isNarrow, view]);

    const focusSearch = useCallback(() => {
      if (isNarrow) {
        if (view !== 'notes') setView('notes');
      } else if (view === 'tasks') {
        setView('split');
      }
      window.setTimeout(() => {
        const input = searchRef.current;
        if (input) {
          input.focus();
          input.select();
        }
      }, 80);
    }, [isNarrow, view]);

    const saveAll = useCallback(async () => {
      await flushNotes();
      if (sync.connected) {
        await sync.syncNow();
      } else {
        pushToast({
          tone: 'success',
          title: 'Saved on this device',
          description: 'Connect a local folder in Settings to mirror to disk.',
          duration: 2600
        });
      }
    }, [flushNotes, sync, pushToast]);

    const toggleTheme = useCallback(() => {
      setTheme(isDark ? 'light' : 'dark');
    }, [isDark]);

    const installApp = useCallback(async () => {
      if (installPrompt) {
        try {
          installPrompt.prompt();
          const choice = await installPrompt.userChoice;
          if (choice && choice.outcome === 'accepted') {
            pushToast({ tone: 'success', title: 'Installing Slate', description: 'It will appear in your Start menu in a moment.' });
          } else {
            pushToast({ tone: 'info', title: 'Install cancelled', description: 'You can install any time from the browser menu.', duration: 3000 });
          }
        } catch (err) {
          pushToast({ tone: 'error', title: 'Install prompt unavailable', description: 'Use the Edge or Chrome menu → Apps → Install this site as an app.' });
        }
        setInstallPrompt(null);
        return;
      }
      pushToast({
        tone: 'info',
        title: 'Install Slate on Windows',
        description: 'Open the Edge or Chrome menu (⋯) → Apps → “Install this site as an app”.',
        duration: 7000
      });
    }, [installPrompt, pushToast]);

    const exportBackup = useCallback(async () => {
      const payload = {
        app: 'Slate',
        schemaVersion: SCHEMA_VERSION,
        appVersion: APP_VERSION,
        exportedAt: new Date().toISOString(),
        notes,
        tasks,
        notebooks
      };
      const json = JSON.stringify(payload, null, 2);
      const filename = `slate-backup-${toDayKey()}.json`;
      try {
        if (window.showSaveFilePicker) {
          const handle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: 'Slate backup', accept: { 'application/json': ['.json'] } }]
          });
          const writable = await handle.createWritable();
          await writable.write(json);
          await writable.close();
          pushToast({ tone: 'success', title: 'Backup saved', description: handle.name });
        } else {
          downloadFile(filename, json, 'application/json');
          pushToast({ tone: 'success', title: 'Backup downloaded', description: filename });
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        pushToast({ tone: 'error', title: 'Export failed', description: (err && err.message) || 'Try again.' });
      }
    }, [notes, tasks, notebooks, pushToast]);

    const importBackup = useCallback(async (file) => {
      let data;
      try {
        const text = await file.text();
        data = JSON.parse(text);
      } catch (err) {
        pushToast({ tone: 'error', title: 'Could not read backup', description: 'Choose a JSON file exported from Slate.' });
        return;
      }

      if (!data || !Array.isArray(data.notes) || !Array.isArray(data.tasks)) {
        pushToast({ tone: 'error', title: 'Not a Slate backup', description: 'The file needs both a notes and a tasks array.' });
        return;
      }

      const normalizedNotes = data.notes.map(normalizeNote).filter(Boolean);
      const nextTasks = data.tasks.map(normalizeTask).filter(Boolean);
      const resolved = resolveWorkspace(normalizedNotes, data.notebooks);
      const nextNotes = resolved.notes;
      const nextNotebooks = resolved.notebooks;
      setSettingsOpen(false);
      setConfirmConfig({
        title: 'Restore this backup?',
        description: 'Your current workspace will be replaced.',
        body: `The backup holds ${nextNotes.length} notes in ${nextNotebooks.length} ${nextNotebooks.length === 1 ? 'notebook' : 'notebooks'} and ${nextTasks.length} tasks. This device currently holds ${notesRef.current.length} notes in ${notebooksRef.current.length} ${notebooksRef.current.length === 1 ? 'notebook' : 'notebooks'} and ${tasksRef.current.length} tasks.`,
        confirmLabel: 'Replace workspace',
        danger: true,
        onConfirm: async () => {
          try {
            await flushNotes();
            await DB.clear('notes');
            await DB.clear('tasks');
            await DB.putMany('notes', nextNotes);
            await DB.putMany('tasks', nextTasks);
            await DB.setKV('notebooks', nextNotebooks);
            await DB.setKV('seeded', true);
            notesRef.current = nextNotes;
            tasksRef.current = nextTasks;
            notebooksRef.current = nextNotebooks;
            persistedNotesRef.current = new Map(nextNotes.map((note) => [note.id, note]));
            dirtyNotesRef.current.clear();
            setNotes(nextNotes);
            setTasks(nextTasks);
            setNotebooks(nextNotebooks);
            const sorted = sortNotes(nextNotes);
            setActiveNoteId(sorted[0] ? sorted[0].id : null);
            setActiveNotebookId(nextNotebooks[0] ? nextNotebooks[0].id : null);
            setCollapsedNotebooks([]);
            setQuery('');
            setEditorMode('rich');
            setSavedAt(Date.now());
            pushToast({
              tone: 'success',
              title: 'Backup restored',
              description: `${nextNotes.length} notes, ${nextNotebooks.length} notebooks and ${nextTasks.length} tasks imported.`
            });
          } catch (err) {
            pushToast({ tone: 'error', title: 'Import failed', description: (err && err.message) || 'Try again.' });
          }
        }
      });
    }, [flushNotes, pushToast]);

    const clearAllData = useCallback(() => {
      setSettingsOpen(false);
      setConfirmConfig({
        title: 'Clear all local data?',
        description: 'This cannot be undone.',
        body: `This removes ${notesRef.current.length} notes, ${notebooksRef.current.length} notebooks, ${tasksRef.current.length} tasks, preferences, and the folder connection from this device. Files already written to a local folder are left untouched.`,
        confirmLabel: 'Clear everything',
        danger: true,
        onConfirm: async () => {
          try {
            if (sync.connected) await sync.disconnect();
            await DB.clearAll();
            const fresh = makeNotebook('Personal');
            await DB.setKV('notebooks', [fresh]);
            notesRef.current = [];
            tasksRef.current = [];
            notebooksRef.current = [fresh];
            persistedNotesRef.current.clear();
            dirtyNotesRef.current.clear();
            setNotes([]);
            setTasks([]);
            setNotebooks([fresh]);
            setActiveNotebookId(fresh.id);
            setCollapsedNotebooks([]);
            setActiveNoteId(null);
            setQuery('');
            setEditorMode('rich');
            try { localStorage.removeItem(PREFS_KEY); } catch (err) { /* noop */ }
            setTheme('system');
            setView('split');
            setFilter('all');
            pushToast({ tone: 'success', title: 'Workspace cleared', description: 'Slate is fresh again.' });
          } catch (err) {
            pushToast({ tone: 'error', title: 'Could not clear data', description: (err && err.message) || 'Reload and try again.' });
          }
        }
      });
    }, [sync, pushToast]);

    /* ------------------------------- effects ------------------------------ */

    useEffect(() => {
      const handleOnline = () => {
        setOnline(true);
        pushToast({ tone: 'success', title: 'Back online', description: 'Changes are stored locally either way.', duration: 2400 });
      };
      const handleOffline = () => {
        setOnline(false);
        pushToast({
          tone: 'info',
          title: 'Working offline',
          description: 'Slate keeps running. Changes sync to your folder as soon as it is available.',
          duration: 3600
        });
      };
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
      return () => {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      };
    }, [pushToast]);

    useEffect(() => {
      const onBeforeInstall = (event) => {
        event.preventDefault();
        setInstallPrompt(event);
      };
      const onInstalled = () => {
        setInstallPrompt(null);
        setIsStandalone(true);
        pushToast({ tone: 'success', title: 'Slate installed', description: 'Launch it any time from the Start menu.' });
      };
      window.addEventListener('beforeinstallprompt', onBeforeInstall);
      window.addEventListener('appinstalled', onInstalled);

      let media;
      try { media = window.matchMedia('(display-mode: standalone)'); } catch (err) { media = null; }
      const onDisplayMode = (event) => setIsStandalone(event.matches);
      if (media) {
        if (media.addEventListener) media.addEventListener('change', onDisplayMode);
        else if (media.addListener) media.addListener(onDisplayMode);
      }

      return () => {
        window.removeEventListener('beforeinstallprompt', onBeforeInstall);
        window.removeEventListener('appinstalled', onInstalled);
        if (media) {
          if (media.removeEventListener) media.removeEventListener('change', onDisplayMode);
          else if (media.removeListener) media.removeListener(onDisplayMode);
        }
      };
    }, [pushToast]);

    useEffect(() => {
      const refresh = async () => {
        try {
          if (navigator.storage && navigator.storage.estimate) {
            const estimate = await navigator.storage.estimate();
            setStorageUsage(estimate.usage || 0);
          }
        } catch (err) { /* noop */ }
      };
      if (settingsOpen) refresh();
    }, [settingsOpen, notes.length, tasks.length]);

    // Service worker: install once, offer a non-disruptive update path.
    useEffect(() => {
      if (!('serviceWorker' in navigator)) return undefined;
      if (!/^https?:$/.test(window.location.protocol)) return undefined;

      let cancelled = false;
      let refreshing = false;
      const hadController = Boolean(navigator.serviceWorker.controller);

      const onControllerChange = () => {
        if (!hadController || refreshing) return;
        refreshing = true;
        window.location.reload();
      };
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

      const setup = async () => {
        try {
          const registration = await navigator.serviceWorker.register('./sw.js', {
            scope: './',
            // Static hosts such as GitHub Pages cache sw.js aggressively; always
            // check the network for a new worker so updates are not delayed.
            updateViaCache: 'none'
          });
          if (cancelled) return;
          swRegRef.current = registration;

          const offerUpdate = () => {
            if (!cancelled && navigator.serviceWorker.controller) setUpdateReady(true);
          };

          if (registration.waiting) offerUpdate();
          registration.addEventListener('updatefound', () => {
            const worker = registration.installing;
            if (!worker) return;
            worker.addEventListener('statechange', () => {
              if (worker.state === 'installed') offerUpdate();
            });
          });

          const checkForUpdate = () => {
            if (document.visibilityState === 'visible') registration.update().catch(() => {});
          };
          document.addEventListener('visibilitychange', checkForUpdate);
          window.addEventListener('online', checkForUpdate);
        } catch (err) {
          console.warn('[slate] Service worker registration failed:', err);
        }
      };

      if (document.readyState === 'complete') setup();
      else window.addEventListener('load', setup, { once: true });

      return () => {
        cancelled = true;
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      };
    }, []);

    useEffect(() => {
      if (!updateReady) return undefined;
      const id = pushToast({
        tone: 'info',
        title: 'A new version of Slate is ready',
        description: 'Refresh when convenient to pick up the update.',
        duration: 0,
        action: {
          label: 'Refresh',
          onClick: () => {
            const registration = swRegRef.current;
            if (registration && registration.waiting) {
              registration.waiting.postMessage({ type: 'SKIP_WAITING' });
            } else {
              window.location.reload();
            }
          }
        }
      });
      return () => dismissToast(id);
    }, [updateReady, pushToast, dismissToast]);

    // Global shortcuts.
    useEffect(() => {
      const handler = (event) => {
        const mod = event.ctrlKey || event.metaKey;
        const target = event.target;
        const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

        // A modal owns the keyboard while open (it traps focus and handles Escape).
        if (settingsOpen || shortcutsOpen || confirmConfig || notebookDialog) return;

        if (mod && !event.altKey && event.key.toLowerCase() === 'n') {
          event.preventDefault();
          createNote();
          return;
        }

        if (mod && event.key === 'Enter') {
          event.preventDefault();
          const input = taskInputRef.current;
          if (input && document.activeElement === input) {
            if (taskFormRef.current) taskFormRef.current.requestSubmit();
            else input.blur();
          } else {
            focusTaskComposer();
          }
          return;
        }

        if (mod && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          focusSearch();
          return;
        }

        if (mod && event.key.toLowerCase() === 's') {
          event.preventDefault();
          saveAll();
          return;
        }

        if (mod && event.key.toLowerCase() === 'e') {
          if (!notesVisible) return;
          event.preventDefault();
          setEditorMode((mode) => (mode === 'rich' ? 'markdown' : mode === 'markdown' ? 'preview' : 'rich'));
          return;
        }

        if (mod && ['1', '2', '3'].includes(event.key)) {
          event.preventDefault();
          const modes = ['tasks', 'notes', 'split'];
          const next = modes[Number(event.key) - 1];
          setView(isNarrow && next === 'split' ? 'notes' : next);
          return;
        }

        if (!typing && event.key === '?') {
          event.preventDefault();
          setShortcutsOpen(true);
          return;
        }
      };

      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, [
      createNote,
      focusTaskComposer,
      focusSearch,
      saveAll,
      notesVisible,
      isNarrow,
      settingsOpen,
      shortcutsOpen,
      confirmConfig,
      notebookDialog
    ]);

    // Handle launch shortcuts (?action=new-note / new-task) from the manifest.
    useEffect(() => {
      if (!hydrated) return;
      let params;
      try { params = new URLSearchParams(window.location.search); } catch (err) { return; }
      const action = params.get('action');
      if (!action) return;

      if (action === 'new-note') createNote();
      else if (action === 'new-task') focusTaskComposer();

      params.delete('action');
      params.delete('source');
      const search = params.toString();
      try {
        window.history.replaceState({}, '', window.location.pathname + (search ? `?${search}` : '') + window.location.hash);
      } catch (err) { /* noop */ }
    }, [hydrated, createNote, focusTaskComposer]);

    /* ------------------------------- rendering ---------------------------- */

    if (loadingError) {
      return (
        <FatalScreen
          message={loadingError}
          onReload={() => window.location.reload()}
          onContinue={() => {
            DB.useLocalFallback('Continuing with an empty local workspace.');
            const fresh = makeNotebook('Personal');
            DB.setKV('notebooks', [fresh]).catch(() => {});
            notesRef.current = [];
            tasksRef.current = [];
            notebooksRef.current = [fresh];
            persistedNotesRef.current.clear();
            dirtyNotesRef.current.clear();
            setNotes([]);
            setTasks([]);
            setNotebooks([fresh]);
            setActiveNotebookId(fresh.id);
            setCollapsedNotebooks([]);
            setActiveNoteId(null);
            setLoadingError(null);
            setHydrated(true);
            pushToast({
              tone: 'error',
              title: 'Started with an empty workspace',
              description: 'Your previous IndexedDB data was not deleted. Reload to try opening it again.',
              duration: 8000
            });
          }}
        />
      );
    }

    if (!hydrated) return <BootScreen />;

    const syncState = SYNC_STATES[sync.status] || SYNC_STATES.disconnected;
    const syncHours = sync.lastSync ? formatRelative(sync.lastSync) : '';

    return (
      <div className="flex h-full flex-col overflow-hidden bg-app">
        <header className="relative z-20 flex h-14 shrink-0 items-center gap-2 border-b border-line/8 bg-panel/80 px-3 backdrop-blur-xl sm:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <Logo />
            <div className="hidden leading-tight md:block">
              <div className="text-[14.3px] font-semibold tracking-[-0.015em] text-ink">Slate</div>
              <div className="text-[9.9px] uppercase tracking-[0.18em] text-muted">Tasks &amp; Notes</div>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 justify-center">
            <nav className="flex items-center gap-0.5 rounded-[10px] border border-line/8 bg-line/[0.025] p-0.5" aria-label="Switch view">
              {[
                { value: 'tasks', label: 'Tasks', icon: 'listChecks', count: counts.active },
                { value: 'notes', label: 'Notes', icon: 'notes', count: notes.length },
                { value: 'split', label: 'Split', icon: 'layout' }
              ].filter((option) => !isNarrow || option.value !== 'split').map((option) => {
                const active = effectiveView === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setView(option.value)}
                    aria-current={active ? 'page' : undefined}
                    title={option.label}
                    className={cx(
                      'inline-flex items-center gap-1.5 rounded-[7px] px-2 py-1.5 text-[12.65px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      active ? 'bg-panel text-ink shadow-sm' : 'text-muted hover:text-ink'
                    )}
                  >
                    <Icon name={option.icon} size={13} />
                    <span className="hidden md:inline">{option.label}</span>
                    {option.count ? (
                      <span className={cx('hidden text-[10.45px] tabular-nums sm:inline', active ? 'text-muted' : 'text-muted/70')}>
                        {option.count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-0.5">
            {installPrompt ? (
              <Btn variant="ghost" className="hidden h-8 lg:inline-flex" onClick={installApp}>
                <Icon name="download" size={13} /> Install
              </Btn>
            ) : null}

            <button
              type="button"
              onClick={() => (sync.connected ? sync.syncNow() : setSettingsOpen(true))}
              title={sync.connected ? `Local folder: ${sync.folderName}` : 'Connect a local folder'}
              className="hidden h-8 max-w-[150px] items-center gap-1.5 rounded-lg border border-line/8 bg-panel px-2 text-[11.55px] text-muted transition-colors hover:border-line/15 hover:text-ink sm:flex"
            >
              <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', syncState.dot)} />
              <span className="truncate">
                {sync.status === 'syncing' ? 'Syncing…'
                  : sync.status === 'synced' ? `Synced ${syncHours}`
                    : sync.status === 'needs-permission' ? 'Reconnect folder'
                      : sync.status === 'error' ? 'Sync issue'
                        : sync.connected ? 'Local folder' : 'Local only'}
              </span>
            </button>

            <IconButton
              label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
              icon={isDark ? 'sun' : 'moon'}
              onClick={toggleTheme}
            />
            <IconButton label="Settings" icon="sliders" onClick={() => setSettingsOpen(true)} />
          </div>
        </header>

        <main className="flex min-h-0 flex-1">
          {showTasks ? (
            <div className={cx(
              'flex min-h-0 min-w-0',
              showNotes
                ? 'w-full lg:w-[43%] lg:min-w-[370px] lg:max-w-[540px] lg:flex-none lg:border-r lg:border-line/8'
                : 'flex-1'
            )}>
              <TaskPanel
                tasks={tasks}
                visibleTasks={visibleTasks}
                filter={filter}
                counts={counts}
                solo={!showNotes}
                onFilterChange={setFilter}
                onAdd={addTask}
                onToggle={toggleTask}
                onUpdate={updateTask}
                onDelete={deleteTask}
                onClearCompleted={clearCompleted}
                inputRef={taskInputRef}
                formRef={taskFormRef}
              />
            </div>
          ) : null}

          {showNotes ? (
            <div className="flex min-h-0 min-w-0 flex-1">
              <NotesPanel
                notes={notes}
                filteredNotes={filteredNotes}
                notebookGroups={notebookGroups}
                notebooks={notebooks}
                collapsedNotebooks={collapsedNotebooks}
                activeNotebookId={activeNotebookId}
                query={query}
                onQueryChange={setQuery}
                activeNoteId={activeNoteId}
                activeNote={activeNote}
                onSelect={selectNote}
                onNew={createNote}
                onDelete={deleteNote}
                onUpdate={updateNote}
                onPin={pinNote}
                onCopy={copyNote}
                onExport={exportNote}
                onToggleNotebook={toggleNotebook}
                onCreateNotebook={() => setNotebookDialog({ mode: 'create', notebook: null })}
                onRenameNotebook={(notebook) => setNotebookDialog({ mode: 'rename', notebook })}
                onDeleteNotebook={deleteNotebook}
                onMoveNotebook={moveNoteToNotebook}
                editorMode={editorMode}
                onEditorModeChange={setEditorMode}
                searchRef={searchRef}
                titleInputRef={titleInputRef}
                newNoteSignal={newNoteSignal}
              />
            </div>
          ) : null}
        </main>

        <footer className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-line/8 bg-app px-3 text-[11px] text-muted sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex items-center gap-1.5" title={online ? 'Works fully offline' : 'No network connection'}>
              <span className={cx('h-1.5 w-1.5 rounded-full', online ? 'bg-emerald-500' : 'bg-amber-500')} />
              {online ? 'Offline-ready' : 'Offline'}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Icon
                name={saveState === 'error' ? 'alert' : saveState === 'saving' ? 'refresh' : 'check'}
                size={10}
                className={cx(
                  saveState === 'error' ? 'text-rose-500' : saveState === 'saving' ? 'animate-spin text-muted' : 'text-emerald-500'
                )}
              />
              {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed' : 'Saved on device'}
            </span>
            {savedAt ? <span className="hidden text-muted/60 md:inline">{formatRelative(savedAt)}</span> : null}
          </div>

          <div className="flex min-w-0 items-center gap-3">
            {sync.connected ? (
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                title="Local folder sync"
                className="hidden max-w-[260px] items-center gap-1.5 truncate text-muted transition-colors hover:text-ink md:inline-flex"
              >
                <Icon name="folder" size={10} />
                <span className="truncate">{sync.folderName}</span>
                <span className="text-muted/50">·</span>
                <span className={sync.status === 'error' ? 'text-rose-500' : ''}>
                  {sync.status === 'syncing' ? 'syncing…' : sync.status === 'synced' ? `synced ${syncHours}` : syncState.label.toLowerCase()}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setShortcutsOpen(true)}
              className="inline-flex items-center gap-1 transition-colors hover:text-ink"
            >
              <Icon name="keyboard" size={10} />
              <span className="hidden sm:inline">Shortcuts</span>
              <Kbd className="hidden h-4 text-[9.9px] sm:inline-flex">?</Kbd>
            </button>
          </div>
        </footer>

        <Toaster toasts={toasts} onDismiss={dismissToast} />

        {settingsOpen ? (
          <SettingsDialog
            onClose={() => setSettingsOpen(false)}
            theme={theme}
            onThemeChange={setTheme}
            sync={sync}
            isStandalone={isStandalone}
            canInstall={Boolean(installPrompt)}
            onInstall={installApp}
            online={online}
            noteCount={notes.length}
            notebookCount={notebooks.length}
            taskCount={tasks.length}
            storageUsage={storageUsage}
            onExport={exportBackup}
            onImport={importBackup}
            onClearData={clearAllData}
            onShowShortcuts={() => { setSettingsOpen(false); setShortcutsOpen(true); }}
          />
        ) : null}

        {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}

        {notebookDialog ? (
          <NotebookDialog
            mode={notebookDialog.mode}
            notebook={notebookDialog.notebook}
            onClose={() => setNotebookDialog(null)}
            onSubmit={(name) => {
              const ok = notebookDialog.mode === 'rename' && notebookDialog.notebook
                ? renameNotebook(notebookDialog.notebook, name)
                : createNotebook(name);
              if (ok) setNotebookDialog(null);
            }}
          />
        ) : null}

        {confirmConfig ? (
          <ConfirmDialog config={confirmConfig} onClose={() => setConfirmConfig(null)} />
        ) : null}
      </div>
    );
  }

  /* --------------------------------------------------------------------------
   * Mount
   * ------------------------------------------------------------------------*/

  const rootElement = document.getElementById('root');
  if (rootElement) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(<App />);
    window.__SLATE_BOOTED__ = true;
    window.Slate = Object.freeze({ version: APP_VERSION, schemaVersion: SCHEMA_VERSION });
  }
})();
