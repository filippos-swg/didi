// Holds one state machine's current state and notifies React when it changes.
// All transitions go through the reducer; nothing else assigns state.

export class Store<State, Event> {
  private state: State;
  private readonly reduce: (state: State, event: Event) => State;
  private readonly listeners = new Set<() => void>();

  constructor(initial: State, reduce: (state: State, event: Event) => State) {
    this.state = initial;
    this.reduce = reduce;
  }

  readonly get = (): State => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispatch(event: Event): void {
    const next = this.reduce(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
