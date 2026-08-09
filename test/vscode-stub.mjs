/**
 * Just enough of the `vscode` module to run agent.ts outside the extension
 * host. Only what agent.ts actually touches — EventEmitter and a settings
 * lookup — so the harness exercises the real bridge rather than a rewrite of
 * it. Testing a reimplementation would prove nothing about the code that ships.
 */

export class EventEmitter {
  #listeners = new Set();

  event = (listener) => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };

  fire(data) {
    for (const listener of [...this.#listeners]) {
      listener(data);
    }
  }

  dispose() {
    this.#listeners.clear();
  }
}

/** Overridden per test via globalThis, so a case can point at a fake binary. */
export const workspace = {
  getConfiguration: () => ({
    get: (key, fallback) => globalThis.__settings?.[key] ?? fallback,
  }),
};

/** The log channel writes into an array the harness can assert on. */
export const window = {
  createOutputChannel: () => ({
    appendLine: (line) => (globalThis.__log ??= []).push(line),
    show: () => {},
    dispose: () => {},
  }),
};
