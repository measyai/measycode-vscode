/*
 * The chat renderer.
 *
 * Two rules hold this file together:
 *
 *   1. Model output is untrusted text arriving through a trusted channel, so
 *      it reaches the DOM as textContent and never as innerHTML. The CSP
 *      would stop an injected <script>, but not an injected <img onerror>,
 *      and there is no reason to rely on the CSP for something this cheap.
 *
 *   2. Nothing here decides anything. A turn ends when the agent says
 *      turn_end, a tool runs when the agent says it may. The renderer draws.
 */

// @ts-check
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  const transcript = document.getElementById("transcript");
  const banner = document.getElementById("banner");
  const approval = document.getElementById("approval");
  const composer = document.getElementById("composer");
  const input = document.getElementById("input");
  const send = document.getElementById("send");
  const meta = document.getElementById("meta");

  const login = document.getElementById("login");
  const loginBrowser = document.getElementById("login-browser");
  const loginDevice = document.getElementById("login-device");
  const loginKey = document.getElementById("login-key");
  const loginKeySubmit = document.getElementById("login-key-submit");
  const loginError = document.getElementById("login-error");

  /** The assistant text block deltas are currently flowing into. */
  let streaming = null;
  /** The tool block tool_body lines currently belong to. */
  let currentTool = null;
  let turnActive = false;

  showEmpty();

  // ── helpers ───────────────────────────────────────────────

  function showEmpty() {
    const hint = el("div", "empty");
    hint.textContent =
      "Ask MeasyCode to change something in this workspace. It reads your code, edits files and runs commands — and asks before it writes.";
    transcript.replaceChildren(hint);
  }

  function clearEmpty() {
    const hint = transcript.querySelector(".empty");
    if (hint) {
      hint.remove();
    }
  }

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    return node;
  }

  /** True when the user is reading the newest output rather than scrolled up. */
  function atBottom() {
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  }

  function append(node) {
    clearEmpty();
    const stick = atBottom();
    transcript.appendChild(node);
    if (stick) {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }

  /** Any block other than assistant text breaks the current stream target. */
  function interrupt() {
    if (streaming) {
      streaming.classList.remove("streaming");
      streaming = null;
    }
  }

  function message(role, text) {
    const wrap = el("div", "msg " + role);
    const label = el("div", "role");
    label.textContent = role === "user" ? "You" : "MeasyCode";
    const bubble = el("div", "bubble");
    bubble.textContent = text || "";
    wrap.append(label, bubble);
    return { wrap, bubble };
  }

  function setMeta(text) {
    meta.textContent = text;
  }

  function setBusy(busy) {
    turnActive = busy;
    send.disabled = busy;
    send.textContent = busy ? "Working…" : "Send";
  }

  // ── banner (auth, blocked, exit) ──────────────────────────

  function showBanner(build) {
    banner.replaceChildren();
    build(banner);
    banner.hidden = false;
  }

  function hideBanner() {
    banner.hidden = true;
    banner.replaceChildren();
  }

  // ── login screen ──────────────────────────────────────────

  /** Signed out is a different screen, not a strip above the chat: there is
   *  nothing useful to do in the composer until this is resolved. */
  function showLogin() {
    login.hidden = false;
    transcript.hidden = true;
    composer.hidden = true;
    approval.hidden = true;
    loginBrowser.disabled = false;
    loginBrowser.textContent = "Continue with MeasyAI";
    loginKeySubmit.disabled = false;
    loginKeySubmit.textContent = "Use this key";
  }

  function hideLogin() {
    login.hidden = true;
    loginDevice.hidden = true;
    transcript.hidden = false;
    composer.hidden = false;
  }

  loginBrowser.addEventListener("click", () => {
    loginBrowser.disabled = true;
    loginBrowser.textContent = "Waiting for your browser…";
    vscode.postMessage({ type: "login" });
  });

  /**
   * The same two rules the CLI applies before it accepts a pasted key, checked
   * here so a typo costs a message rather than a full agent restart.
   */
  function keyProblem(key) {
    if (!key) {
      return "Paste a key first.";
    }
    if (key.startsWith("msys_")) {
      return "That is a session token, not an API key.";
    }
    if (!key.startsWith("msy_")) {
      return "A MeasyAI API key starts with msy_.";
    }
    return null;
  }

  function submitKey() {
    const key = loginKey.value.trim();
    const problem = keyProblem(key);

    if (problem) {
      loginError.textContent = problem;
      loginError.hidden = false;
      loginKey.setAttribute("aria-invalid", "true");
      loginKey.focus();
      return;
    }

    loginError.hidden = true;
    loginKey.removeAttribute("aria-invalid");
    loginKeySubmit.disabled = true;
    loginKeySubmit.textContent = "Starting…";

    vscode.postMessage({ type: "apiKey", key });
    // Not kept around after it has been handed over. The extension puts it in
    // secret storage; there is no reason for a copy to sit in the DOM.
    loginKey.value = "";
  }

  loginKeySubmit.addEventListener("click", submitKey);

  loginKey.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitKey();
    }
  });

  loginKey.addEventListener("input", () => {
    loginError.hidden = true;
    loginKey.removeAttribute("aria-invalid");
  });

  function showDeviceCode(url, code) {
    loginDevice.replaceChildren();

    const p = el("div");
    p.textContent = "Approve this code in your browser:";

    const codeEl = el("code");
    codeEl.textContent = code;

    const link = el("a");
    link.href = url;
    link.textContent = url;

    loginDevice.append(p, codeEl, el("div"), link);
    loginDevice.hidden = false;
  }

  // ── approval ──────────────────────────────────────────────

  function askApproval(id, name, detail) {
    approval.replaceChildren();

    const what = el("div", "what");
    what.textContent = name;

    const body = el("div", "detail");
    body.textContent = detail || "";

    const actions = el("div", "actions");

    const answer = (allow, always) => {
      vscode.postMessage({ type: "approval", id, allow, always });
      approval.hidden = true;
      approval.replaceChildren();
      input.focus();
    };

    const allow = el("button");
    allow.textContent = "Allow";
    allow.addEventListener("click", () => answer(true, false));

    const always = el("button", "secondary");
    always.textContent = "Always allow";
    always.title = "Switch to Developer mode: stop asking for this session";
    always.addEventListener("click", () => answer(true, true));

    const deny = el("button", "secondary");
    deny.textContent = "Deny";
    deny.addEventListener("click", () => answer(false, false));

    actions.append(allow, always, deny);
    approval.append(what, body, actions);
    approval.hidden = false;

    // Focus lands on Deny, not Allow: the agent is asking to write, and a
    // stray Enter should not be what grants it.
    deny.focus();
  }

  // ── agent events ──────────────────────────────────────────

  function onAgentEvent(event) {
    switch (event.kind) {
      case "ready": {
        hideBanner();
        hideLogin();
        const model = (event.model || "").replace(/^measyai\//, "");
        const who = event.account ? " · " + event.account : "";
        setMeta(model + who);
        break;
      }

      case "auth_required":
        setMeta("");
        showLogin();
        break;

      case "auth_prompt":
        showDeviceCode(event.url, event.code);
        break;

      case "user": {
        interrupt();
        currentTool = null;
        const { wrap } = message("user", event.text);
        append(wrap);
        break;
      }

      case "turn_start":
        setBusy(true);
        break;

      case "delta": {
        currentTool = null;
        if (!streaming) {
          const { wrap, bubble } = message("assistant", "");
          bubble.classList.add("streaming");
          streaming = bubble;
          append(wrap);
        }
        const stick = atBottom();
        streaming.textContent += event.text;
        if (stick) {
          transcript.scrollTop = transcript.scrollHeight;
        }
        break;
      }

      case "reasoning": {
        interrupt();
        // One collapsible block per contiguous run of reasoning, appended to
        // rather than stacked: the model emits it in many small pieces.
        let box = transcript.lastElementChild;
        if (!box || !box.classList.contains("reasoning")) {
          box = el("details", "reasoning");
          const summary = el("summary");
          summary.textContent = "Thinking";
          const body = el("div", "body");
          box.append(summary, body);
          append(box);
        }
        box.querySelector(".body").textContent += event.text;
        break;
      }

      case "tool_start": {
        interrupt();
        const box = el("details", "tool");
        const summary = el("summary");

        const name = el("span", "name");
        name.textContent = event.name;

        const arg = el("span", "arg");
        arg.textContent = event.arg || "";

        const result = el("span", "result");
        result.textContent = "running…";

        summary.append(name, arg, result);
        box.appendChild(summary);
        append(box);
        currentTool = box;
        break;
      }

      case "tool_body": {
        const box = currentTool;
        if (!box) {
          break;
        }
        let body = box.querySelector(".body");
        if (!body) {
          body = el("pre", "body");
          box.appendChild(body);
        }
        body.textContent += (body.textContent ? "\n" : "") + event.text;
        break;
      }

      case "tool_result": {
        const box = currentTool;
        if (!box) {
          break;
        }
        const result = box.querySelector(".result");
        result.textContent = event.summary || (event.ok ? "done" : "failed");
        result.classList.add(event.ok ? "ok" : "bad");
        // A failure is the one result worth opening unasked.
        if (!event.ok) {
          box.open = true;
        }
        currentTool = null;
        break;
      }

      case "approval_request":
        askApproval(event.id, event.name, event.text);
        break;

      case "turn_end":
        interrupt();
        currentTool = null;
        setBusy(false);
        break;

      case "turn_stats": {
        const bits = [];
        if (event.tokens) {
          bits.push(event.tokens.toLocaleString() + " tokens");
        }
        if (event.millis) {
          bits.push((event.millis / 1000).toFixed(1) + "s");
        }
        if (bits.length) {
          const line = el("div", "notice");
          line.textContent = bits.join(" · ");
          append(line);
        }
        break;
      }

      case "notice": {
        interrupt();
        const line = el("div", "notice");
        line.textContent = event.text;
        append(line);
        break;
      }

      case "error": {
        interrupt();
        setBusy(false);
        const line = el("div", "error");
        line.textContent = event.text;
        append(line);
        break;
      }

      case "bye":
        setBusy(false);
        break;
    }
  }

  // ── messages from the extension ───────────────────────────

  window.addEventListener("message", (e) => {
    const message = e.data;
    switch (message.type) {
      case "agent":
        onAgentEvent(message.event);
        break;

      case "blocked":
        showBanner((root) => {
          const p = el("div");
          p.textContent = message.text;
          root.appendChild(p);
        });
        break;

      case "exit": {
        setBusy(false);
        interrupt();
        const line = el("div", "notice");
        line.textContent = message.reason;
        append(line);
        setMeta("");
        break;
      }

      case "compose":
        input.value = input.value ? input.value + "\n" + message.text : message.text;
        autogrow();
        input.focus();
        break;

      case "clear":
        showEmpty();
        interrupt();
        currentTool = null;
        break;
    }
  });

  // ── composer ──────────────────────────────────────────────

  function autogrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  input.addEventListener("input", autogrow);

  input.addEventListener("keydown", (e) => {
    // Enter sends, Shift+Enter breaks the line. The composer is a textarea
    // precisely so a multi-line prompt is possible.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || turnActive) {
      return;
    }
    vscode.postMessage({ type: "prompt", text });
    input.value = "";
    autogrow();
  });

  vscode.postMessage({ type: "mounted" });
})();
