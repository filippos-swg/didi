// Browser side of the signalling WebSocket.

import { parseServerMessage, SIGNAL_PATH, type ClientMessage, type ServerMessage } from "../../shared/signal-protocol.ts";

export interface SignalConnection {
  send(message: ClientMessage): void;
  /** Closes the socket. The onClose callback is not called for a close we asked for. */
  close(code?: number): void;
}

export class SignalUnavailableError extends Error {
  constructor() {
    super("Could not reach the didi server");
  }
}

function signalUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${SIGNAL_PATH}`;
}

/** Resolves once the socket is open; rejects with SignalUnavailableError if it never opens. */
export function connectSignal(
  onMessage: (message: ServerMessage) => void,
  onClose: (code: number) => void,
): Promise<SignalConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(signalUrl());
    let opened = false;
    let closedByUs = false;

    socket.addEventListener("open", () => {
      opened = true;
      resolve({
        send(message) {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
        },
        close(code = 1000) {
          closedByUs = true;
          socket.close(code);
        },
      });
    });
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (closedByUs || typeof event.data !== "string") return;
      const message = parseServerMessage(event.data);
      if (message === null) {
        console.warn("didi: ignoring a malformed signalling message");
        return;
      }
      onMessage(message);
    });
    socket.addEventListener("close", (event) => {
      if (!opened) reject(new SignalUnavailableError());
      else if (!closedByUs) onClose(event.code);
    });
  });
}
