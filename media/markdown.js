/*
 * A small Markdown renderer for the transcript.
 *
 * Everything it produces is built with createElement and textContent. Nothing
 * is ever assembled as an HTML string, so model output cannot introduce an
 * element — not a <script>, which the CSP would stop anyway, and not an
 * <img onerror>, which it would not. That constraint is the reason this exists
 * instead of a library: a Markdown-to-HTML library hands back a string, and
 * the only way to use one safely is to sanitise it afterwards.
 *
 * It covers what a coding agent actually emits: fenced code, inline code,
 * bold, italic, headings, lists, blockquotes and links. Anything it does not
 * recognise stays as text, which is the right failure — unrendered Markdown is
 * readable, mangled Markdown is not.
 */

(function () {
  "use strict";

  /** Inline spans: `code`, **bold**, *italic*, [text](url). */
  function renderInline(text, parent, onLink) {
    // One pass, longest-delimiter-first so ** wins over *.
    const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) {
        parent.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      const token = match[0];

      if (token.startsWith("`")) {
        const code = document.createElement("code");
        code.textContent = token.slice(1, -1);
        parent.appendChild(code);
      } else if (token.startsWith("**") || token.startsWith("__")) {
        const strong = document.createElement("strong");
        strong.textContent = token.slice(2, -2);
        parent.appendChild(strong);
      } else if (token.startsWith("[")) {
        const split = token.indexOf("](");
        const label = token.slice(1, split);
        const url = token.slice(split + 2, -1);
        // A link in a webview cannot navigate, so it is a button that asks the
        // extension to open it. Only http(s) — a javascript: or file: URL has
        // no business arriving from a model.
        if (/^https?:\/\//i.test(url)) {
          const link = document.createElement("button");
          link.type = "button";
          link.className = "md-link";
          link.textContent = label;
          link.title = url;
          link.addEventListener("click", () => onLink(url));
          parent.appendChild(link);
        } else {
          parent.appendChild(document.createTextNode(token));
        }
      } else {
        const em = document.createElement("em");
        em.textContent = token.slice(1, -1);
        parent.appendChild(em);
      }
      last = pattern.lastIndex;
    }

    if (last < text.length) {
      parent.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function codeBlock(code, language, onCopy) {
    const wrap = document.createElement("div");
    wrap.className = "md-code";

    const bar = document.createElement("div");
    bar.className = "md-code-bar";

    const lang = document.createElement("span");
    lang.className = "md-code-lang";
    lang.textContent = language || "";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "md-copy";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      onCopy(code);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    });

    bar.append(lang, copy);

    const pre = document.createElement("pre");
    const el = document.createElement("code");
    el.textContent = code;
    pre.appendChild(el);

    wrap.append(bar, pre);
    return wrap;
  }

  /**
   * Renders `text` into a fragment.
   *
   * `onLink` and `onCopy` are handed in rather than imported, so this file
   * knows nothing about the extension bridge and can be exercised on its own.
   */
  function renderMarkdown(text, onLink, onCopy) {
    const out = document.createDocumentFragment();
    const lines = text.split("\n");

    let i = 0;
    let paragraph = null;

    const flush = () => {
      paragraph = null;
    };

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code. An unterminated fence runs to the end, which is what a
      // half-streamed answer looks like.
      const fence = /^```(\w*)\s*$/.exec(line);
      if (fence) {
        flush();
        const language = fence[1];
        const body = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++; // closing fence
        out.appendChild(codeBlock(body.join("\n"), language, onCopy));
        continue;
      }

      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        const h = document.createElement("h" + (heading[1].length + 2 > 6 ? 6 : heading[1].length + 2));
        h.className = "md-h";
        renderInline(heading[2], h, onLink);
        out.appendChild(h);
        i++;
        continue;
      }

      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        flush();
        const list = document.createElement(bullet ? "ul" : "ol");
        list.className = "md-list";
        while (i < lines.length) {
          const b = /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
          const n = /^\s*(\d+)[.)]\s+(.*)$/.exec(lines[i]);
          if (bullet && !b) break;
          if (!bullet && !n) break;
          const item = document.createElement("li");
          renderInline(bullet ? b[1] : n[2], item, onLink);
          list.appendChild(item);
          i++;
        }
        out.appendChild(list);
        continue;
      }

      const quote = /^>\s?(.*)$/.exec(line);
      if (quote) {
        flush();
        const block = document.createElement("blockquote");
        block.className = "md-quote";
        renderInline(quote[1], block, onLink);
        out.appendChild(block);
        i++;
        continue;
      }

      if (line.trim() === "") {
        flush();
        i++;
        continue;
      }

      if (!paragraph) {
        paragraph = document.createElement("p");
        paragraph.className = "md-p";
        out.appendChild(paragraph);
      } else {
        paragraph.appendChild(document.createTextNode("\n"));
      }
      renderInline(line, paragraph, onLink);
      i++;
    }

    return out;
  }

  window.renderMarkdown = renderMarkdown;
})();
