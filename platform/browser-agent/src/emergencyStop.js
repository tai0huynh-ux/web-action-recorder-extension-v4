export class EmergencyStop {
  constructor() {
    this.controllers = new Map();
    this.listeners = new Set();
    this.stoppedAt = undefined;
  }

  createSignal(scope = 'default') {
    const controller = new AbortController();
    const list = this.controllers.get(scope) || new Set();
    list.add(controller);
    this.controllers.set(scope, list);
    controller.signal.addEventListener('abort', () => list.delete(controller), { once: true });
    return controller.signal;
  }

  onStop(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stopAll() {
    this.stoppedAt = new Date().toISOString();
    for (const list of this.controllers.values()) {
      for (const controller of list) controller.abort();
      list.clear();
    }
    await Promise.all([...this.listeners].map((listener) => listener()));
    return { stopped: true, stoppedAt: this.stoppedAt };
  }

  getState() {
    return {
      stoppedAt: this.stoppedAt,
      trackedScopes: [...this.controllers.entries()].filter(([, list]) => list.size).map(([scope]) => scope)
    };
  }
}
