import { describe, expect, it, vi } from 'vitest';

import { PROTOCOL_ERROR_CODE, ProtocolError } from '@termhub/shared';
import type { SessionAttachResult, SessionId } from '@termhub/shared';

import type { AttachmentTransportClient } from './session-attachments.js';
import { SessionAttachments } from './session-attachments.js';

// Unit tests for `SessionAttachments` (docs/specs/m2.6-boot-reattach.md
// section 3.2) against a fake `{ request }` — this module deliberately
// never imports `electron` or a real `TransportClient`/socket, so a fake
// that records calls and lets the test control exactly when each one
// settles is both sufficient and what makes the ordering-sensitive tests
// below (rule 1: "no máximo um attach ou detach em voo por sessão")
// deterministic instead of racy.

interface RecordedCall {
  method: string;
  params: unknown;
}

/** A controllable fake of `AttachmentTransportClient`: every `request()` call is recorded and returns a deferred promise the test resolves/rejects on its own schedule — exactly what's needed to force a `session.attach` to still be in flight when a `release()` arrives (test 5 below), or to prove rule 1's "next operation chains behind the previous one's response". */
function fakeClient(): {
  client: AttachmentTransportClient;
  calls: RecordedCall[];
  respond: (index: number, result: unknown) => void;
  reject: (index: number, err: unknown) => void;
} {
  const calls: RecordedCall[] = [];
  const deferreds: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];

  const client: AttachmentTransportClient = {
    request<TResult>(method: string, params: unknown): Promise<TResult> {
      calls.push({ method, params });
      return new Promise<TResult>((resolve, reject) => {
        deferreds.push({ resolve: resolve as (v: unknown) => void, reject });
      });
    },
  };

  return {
    client,
    calls,
    respond(index, result) {
      const deferred = deferreds[index];
      if (deferred === undefined) {
        throw new Error(`no pending request at index ${index}`);
      }
      deferred.resolve(result);
    },
    reject(index, err) {
      const deferred = deferreds[index];
      if (deferred === undefined) {
        throw new Error(`no pending request at index ${index}`);
      }
      deferred.reject(err);
    },
  };
}

/**
 * An `AttachmentTransportClient` whose `request()` resolves/rejects
 * immediately (via a microtask), for tests that don't need to control
 * timing by hand. `handler` throwing is converted into a *rejected
 * promise*, never a synchronous throw out of `request()` itself — matching
 * the real `TransportClient.request()` (`packages/daemon/src/
 * transport-client.ts`), which always returns a promise (rejecting it,
 * including for a `ProtocolError` the daemon sent back) and never throws
 * synchronously. A fake that let a thrown error escape `request()`
 * synchronously would exercise a code path `SessionAttachments` never
 * actually has to handle in production.
 */
function autoClient(handler: (method: string, params: unknown) => unknown): {
  client: AttachmentTransportClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client: AttachmentTransportClient = {
    request<TResult>(method: string, params: unknown): Promise<TResult> {
      calls.push({ method, params });
      return new Promise<TResult>((resolve, reject) => {
        try {
          resolve(handler(method, params) as TResult);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
  };
  return { client, calls };
}

function attachResult(sessionId: SessionId): SessionAttachResult {
  return {
    session: {
      id: sessionId,
      name: 'test',
      cwd: 'C:\\',
      shell: 'pwsh.exe',
      cols: 80,
      rows: 24,
      status: 'running',
      createdAt: 0,
    },
  };
}

describe('SessionAttachments', () => {
  it('first acquire() sends session.attach and resolves with its result; accepts() becomes true for that holder', async () => {
    const sessionId = 1 as SessionId;
    const { client, calls } = autoClient((method) =>
      method === 'session.attach' ? attachResult(sessionId) : {},
    );
    const book = new SessionAttachments(client);

    expect(book.accepts('h1', sessionId)).toBe(false);
    const result = await book.acquire('h1', sessionId);

    expect(calls).toEqual([{ method: 'session.attach', params: { sessionId } }]);
    expect(result).toEqual(attachResult(sessionId));
    expect(book.accepts('h1', sessionId)).toBe(true);
  });

  it('a second holder joining an already-attached session does not send a second session.attach, and gets the same cached result (section 3.2 rule 2)', async () => {
    const sessionId = 2 as SessionId;
    const { client, calls } = autoClient((method) =>
      method === 'session.attach' ? attachResult(sessionId) : {},
    );
    const book = new SessionAttachments(client);

    const first = await book.acquire('h1', sessionId);
    const second = await book.acquire('h2', sessionId);

    expect(calls.filter((c) => c.method === 'session.attach')).toHaveLength(1);
    expect(second).toEqual(first);
    expect(book.accepts('h1', sessionId)).toBe(true);
    expect(book.accepts('h2', sessionId)).toBe(true);
  });

  it('release() of the last holder sends session.detach; accepts() becomes false; release() of a non-holder is a no-op', async () => {
    const sessionId = 3 as SessionId;
    const { client, calls } = autoClient(() => ({}));
    const book = new SessionAttachments(client);

    await book.acquire('h1', sessionId);
    book.release('never-a-holder', sessionId); // no-op, doesn't throw
    expect(calls.filter((c) => c.method === 'session.detach')).toHaveLength(0);

    book.release('h1', sessionId);
    await vi.waitFor(() => {
      expect(calls.filter((c) => c.method === 'session.detach')).toHaveLength(1);
    });
    expect(calls.at(-1)).toEqual({ method: 'session.detach', params: { sessionId } });

    await vi.waitFor(() => {
      expect(book.accepts('h1', sessionId)).toBe(false);
    });

    // Idempotent: releasing again does nothing further.
    book.release('h1', sessionId);
    expect(calls.filter((c) => c.method === 'session.detach')).toHaveLength(1);
  });

  it('releaseAll(holder) releases every session that holder held, and leaves others untouched', async () => {
    const s1 = 10 as SessionId;
    const s2 = 11 as SessionId;
    const { client, calls } = autoClient((method, params) =>
      method === 'session.attach'
        ? attachResult((params as { sessionId: SessionId }).sessionId)
        : {},
    );
    const book = new SessionAttachments(client);

    await book.acquire('h1', s1);
    await book.acquire('h1', s2);
    await book.acquire('h2', s2); // h2 also holds s2 — releaseAll(h1) must not detach it

    book.releaseAll('h1');

    await vi.waitFor(() => {
      expect(calls.filter((c) => c.method === 'session.detach')).toEqual([
        { method: 'session.detach', params: { sessionId: s1 } },
      ]);
    });
    expect(book.accepts('h1', s1)).toBe(false);
    expect(book.accepts('h1', s2)).toBe(false);
    expect(book.accepts('h2', s2)).toBe(true); // h2's hold on s2 survives
  });

  it('acquire() on a session the daemon rejects propagates the ProtocolError and does not register the holder (required test 7)', async () => {
    const sessionId = 999 as SessionId;
    const { client } = autoClient(() => {
      throw new ProtocolError(PROTOCOL_ERROR_CODE.SESSION_NOT_FOUND, 'no session with id 999');
    });
    const book = new SessionAttachments(client);

    await expect(book.acquire('h1', sessionId)).rejects.toMatchObject({
      code: PROTOCOL_ERROR_CODE.SESSION_NOT_FOUND,
    });
    expect(book.accepts('h1', sessionId)).toBe(false);

    // A later, successful attach for the same session still works — the
    // failed attempt didn't wedge the session's state machine.
    const { client: okClient } = autoClient(() => attachResult(sessionId));
    const okBook = new SessionAttachments(okClient);
    await expect(okBook.acquire('h1', sessionId)).resolves.toBeDefined();
  });

  it('rule 1: two acquire() calls issued back to back (no await between) for different holders send only one session.attach', async () => {
    const sessionId = 4 as SessionId;
    const { client, calls } = autoClient(() => attachResult(sessionId));
    const book = new SessionAttachments(client);

    const p1 = book.acquire('h1', sessionId);
    const p2 = book.acquire('h2', sessionId); // issued synchronously, before p1 has any chance to settle

    await Promise.all([p1, p2]);

    expect(calls.filter((c) => c.method === 'session.attach')).toHaveLength(1);
    expect(book.accepts('h1', sessionId)).toBe(true);
    expect(book.accepts('h2', sessionId)).toBe(true);
  });

  it('reload scenario: release (last holder) then a new acquire before the detach has settled waits for the detach, then sends a fresh attach — attach, detach, attach, never two attaches or two detaches overlapping (section 3.2 rule 1/2)', async () => {
    const sessionId = 5 as SessionId;
    const { client, calls, respond } = fakeClient();
    const book = new SessionAttachments(client);

    const firstAcquire = book.acquire('old-instance', sessionId);
    respond(0, attachResult(sessionId)); // session.attach #1 resolves
    await firstAcquire;

    book.release('old-instance', sessionId); // last holder -> schedules session.detach
    // The new renderer instance acquires while the detach is presumably
    // still in flight — this is the M2.6 reload race (section 2.3):
    // `acquire` must wait for the detach's response before sending its own
    // fresh attach, never overlap it.
    const secondAcquire = book.acquire('new-instance', sessionId);

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ method: 'session.detach', params: { sessionId } });
    // The new attach has NOT been sent yet — it must wait for the detach's
    // response first (rule 1: at most one op in flight per session).
    expect(calls).toHaveLength(2);

    respond(1, {}); // session.detach resolves
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]).toEqual({ method: 'session.attach', params: { sessionId } });

    respond(2, attachResult(sessionId)); // session.attach #2 resolves
    await secondAcquire;

    expect(calls.map((c) => c.method)).toEqual([
      'session.attach',
      'session.detach',
      'session.attach',
    ]);
    expect(book.accepts('old-instance', sessionId)).toBe(false);
    expect(book.accepts('new-instance', sessionId)).toBe(true);
  });

  it('accepts() is false while a session is detaching, even though the holder that just released it is still (briefly) in the map key space', async () => {
    const sessionId = 6 as SessionId;
    const { client, respond } = fakeClient();
    const book = new SessionAttachments(client);

    const acquirePromise = book.acquire('h1', sessionId);
    respond(0, attachResult(sessionId));
    await acquirePromise;
    expect(book.accepts('h1', sessionId)).toBe(true);

    book.release('h1', sessionId);
    // Between release() and the detach's response, accepts() must already
    // be false — routing rule 4 discards chunks the instant a session
    // leaves 'attaching'/'attached', not just once 'detached' is reached.
    expect(book.accepts('h1', sessionId)).toBe(false);

    respond(1, {});
    await vi.waitFor(() => expect(book.accepts('h1', sessionId)).toBe(false));
  });
});
