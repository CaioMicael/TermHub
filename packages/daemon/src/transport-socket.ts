import type { Socket } from 'node:net';

import { FrameDecoder, ProtocolError } from '@termhub/shared';
import type { Frame } from '@termhub/shared';

// Thin wrapper around a single `net.Socket` that owns two things every
// connection (server-side per-client, and the client's own socket) needs
// identically: decoding incoming bytes into `Frame`s via `FrameDecoder`,
// and writing outgoing frames back out *with backpressure respected*. This
// is the one place `socket.write()`'s return value is checked, so neither
// transport-server.ts nor transport-client.ts can accidentally reintroduce
// the "ignore backpressure, buffer the world" bug by writing straight to
// the socket themselves.
//
// ## Backpressure
//
// `socket.write()` returns `false` once the OS-level send buffer is full;
// the correct response is to stop writing until `'drain'` fires, not to
// keep calling `write()` (which still "succeeds" — Node queues internally —
// but with no ceiling, that queue is an unbounded memory leak under a slow
// reader and a fast writer, exactly what a daemon streaming megabytes of
// agent output looks like). `send()` below queues outgoing frames in
// `outQueue` once `write()` signals `false`, and only resumes writing them,
// strictly in order, once `'drain'` fires and flips `writable` back to
// `true`. `end()` respects the same queue — closing the writable side is
// deferred until anything already queued has actually been handed to the
// socket, so a graceful close (e.g. the handshake-rejection path) can never
// truncate its own final message.

export interface FramedSocketHandlers {
  /** Called once per frame, in arrival order, for every frame a `push()` call decoded successfully. */
  onFrame: (frame: Frame) => void;
  /**
   * Called when `FrameDecoder.push` throws. Per protocol.ts's contract, the
   * decoder is unusable after this — callers must tear the connection down
   * (this class does not do it automatically, since server and client want
   * different logging/teardown around it).
   */
  onDecodeError: (err: ProtocolError) => void;
  /** Called exactly once, when the underlying socket actually closes (for any reason: graceful end, destroy, or a network-level error). */
  onClose: () => void;
}

export class FramedSocket {
  private readonly decoder = new FrameDecoder();
  private readonly outQueue: Uint8Array[] = [];
  private writable = true;
  private closed = false;
  private pendingEnd = false;

  constructor(
    private readonly socket: Socket,
    private readonly handlers: FramedSocketHandlers,
  ) {
    socket.on('data', (chunk: Buffer) => {
      this.handleData(chunk);
    });
    socket.on('drain', () => {
      this.flush();
    });
    socket.on('close', () => {
      this.closed = true;
      this.outQueue.length = 0;
      this.handlers.onClose();
    });
    // A `net.Socket` with zero `'error'` listeners rethrows the error as an
    // uncaught exception, which would take the whole daemon process down
    // over something as ordinary as the other end resetting the
    // connection. `'close'` (always emitted after `'error'`, per Node's
    // docs) is where actual cleanup happens; this listener exists purely to
    // stop that promotion.
    socket.on('error', () => {});
  }

  private handleData(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.handlers.onDecodeError(err);
        return;
      }
      // Not something FrameDecoder's contract says it throws — surface it
      // rather than silently swallowing an unexpected bug.
      throw err;
    }
    for (const frame of frames) {
      this.handlers.onFrame(frame);
    }
  }

  /** Queues (or writes, if there's room) one already-encoded frame. Order is always preserved relative to other `send()` calls on this instance. No-op once the connection is closed. */
  send(buf: Uint8Array): void {
    if (this.closed || this.pendingEnd) {
      return;
    }
    if (!this.writable) {
      this.outQueue.push(buf);
      return;
    }
    this.writeNow(buf);
  }

  private writeNow(buf: Uint8Array): void {
    let ok: boolean;
    try {
      ok = this.socket.write(buf);
    } catch {
      // The socket was torn down between our `closed` check and this call
      // (e.g. the peer reset the connection concurrently); `'close'` will
      // still fire and run normal cleanup, nothing further to do here.
      return;
    }
    if (!ok) {
      this.writable = false;
    }
  }

  private flush(): void {
    this.writable = true;
    while (this.writable && this.outQueue.length > 0) {
      const next = this.outQueue.shift();
      if (next === undefined) {
        break;
      }
      this.writeNow(next);
    }
    if (this.writable && this.pendingEnd && this.outQueue.length === 0) {
      this.finishEnd();
    }
  }

  /**
   * Gracefully closes the writable side once every already-queued frame has
   * actually reached the socket. Used for the handshake-rejection path
   * (send the `handshake-ack` failure, then close) so a client that was
   * momentarily backpressured still receives the full rejection reason
   * instead of a truncated write followed by an abrupt reset.
   */
  end(): void {
    if (this.closed || this.pendingEnd) {
      return;
    }
    if (this.outQueue.length > 0 || !this.writable) {
      this.pendingEnd = true;
      return;
    }
    this.finishEnd();
  }

  private finishEnd(): void {
    this.pendingEnd = false;
    this.socket.end();
  }

  /** Immediately tears down the connection, discarding anything still queued. Used when the connection is no longer trustworthy (protocol violation) or the server is shutting down. */
  destroy(): void {
    if (this.closed) {
      return;
    }
    // Flip synchronously (not just in the `'close'` handler) so a `send()`
    // racing this call never attempts `socket.write()` on a socket that's
    // already mid-teardown — the real `'close'` event still fires
    // afterward and re-sets this (harmless) on its way to calling
    // `onClose`.
    this.closed = true;
    this.outQueue.length = 0;
    this.pendingEnd = false;
    this.socket.destroy();
  }
}
