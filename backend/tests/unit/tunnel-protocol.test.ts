import { describe, it, expect } from 'vitest';
import { encodeTunnelMessage, decodeTunnelMessage } from '../../src/services/tunnel-protocol.js';

describe('tunnel-protocol', () => {
  it('round-trips a runtime_hello message', () => {
    const msg = {
      type: 'runtime_hello' as const,
      runtimeId: 'did:key:z6MkTest',
      nonce: 'abc123',
      signature: 'sig456',
    };
    const encoded = encodeTunnelMessage(msg);
    const decoded = decodeTunnelMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  it('round-trips a proxied_request message', () => {
    const msg = {
      type: 'proxied_request' as const,
      requestId: 'req-123',
      agent: 'my-agent',
      payload: [1, 2, 3],
    };
    const encoded = encodeTunnelMessage(msg);
    const decoded = decodeTunnelMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  it('round-trips an exposure_update message', () => {
    const msg = {
      type: 'exposure_update' as const,
      payload: {
        instanceId: 'inst-1',
        exposure: 'public' as const,
        allowedUserIds: ['1', '2'],
      },
    };
    const encoded = encodeTunnelMessage(msg);
    const decoded = decodeTunnelMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  it('handles fragmented Buffer arrays', () => {
    const msg = {
      type: 'heartbeat' as const,
      seq: 42,
    };
    const encoded = encodeTunnelMessage(msg);
    const fragments = [encoded.slice(0, 5), encoded.slice(5)];
    const decoded = decodeTunnelMessage(fragments);
    expect(decoded).toEqual(msg);
  });
});
