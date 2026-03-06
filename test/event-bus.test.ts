import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../src/event-bus.js';

// ---------------------------------------------------------------------------
// Test event map for type safety
// ---------------------------------------------------------------------------
type TestEvents = {
  'user:login': [userId: string, timestamp: number];
  'user:logout': [userId: string];
  'order:created': [orderId: string, amount: number, currency: string];
  'ping': [];
};

describe('EventBus', () => {
  let bus: EventBus<TestEvents>;

  beforeEach(() => {
    bus = new EventBus<TestEvents>();
  });

  // -------------------------------------------------------------------------
  // on / emit
  // -------------------------------------------------------------------------
  describe('on/emit', () => {
    it('handler receives correct typed args', () => {
      const handler = vi.fn();
      bus.on('user:login', handler);
      bus.emit('user:login', 'u-1', Date.now());

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith('u-1', expect.any(Number));
    });

    it('handler receives multiple typed args', () => {
      const handler = vi.fn();
      bus.on('order:created', handler);
      bus.emit('order:created', 'ord-1', 99.99, 'USD');

      expect(handler).toHaveBeenCalledWith('ord-1', 99.99, 'USD');
    });

    it('handler works with zero-arg events', () => {
      const handler = vi.fn();
      bus.on('ping', handler);
      bus.emit('ping');

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith();
    });
  });

  // -------------------------------------------------------------------------
  // off
  // -------------------------------------------------------------------------
  describe('off', () => {
    it('removes specific handler', () => {
      const handler = vi.fn();
      bus.on('user:login', handler);
      bus.off('user:login', handler);
      bus.emit('user:login', 'u-1', 123);

      expect(handler).not.toHaveBeenCalled();
    });

    it('does not remove other handlers for the same event', () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();
      bus.on('user:login', handlerA);
      bus.on('user:login', handlerB);
      bus.off('user:login', handlerA);
      bus.emit('user:login', 'u-1', 123);

      expect(handlerA).not.toHaveBeenCalled();
      expect(handlerB).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // once
  // -------------------------------------------------------------------------
  describe('once', () => {
    it('fires handler only once', () => {
      const handler = vi.fn();
      bus.once('user:logout', handler);
      bus.emit('user:logout', 'u-1');
      bus.emit('user:logout', 'u-2');

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith('u-1');
    });
  });

  // -------------------------------------------------------------------------
  // onAny (wildcard)
  // -------------------------------------------------------------------------
  describe('onAny', () => {
    it('receives all events with event name', () => {
      const handler = vi.fn();
      bus.onAny(handler);
      bus.emit('user:login', 'u-1', 100);
      bus.emit('user:logout', 'u-2');

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, 'user:login', 'u-1', 100);
      expect(handler).toHaveBeenNthCalledWith(2, 'user:logout', 'u-2');
    });

    it('fires alongside specific handlers', () => {
      const specificHandler = vi.fn();
      const anyHandler = vi.fn();
      bus.on('ping', specificHandler);
      bus.onAny(anyHandler);
      bus.emit('ping');

      expect(specificHandler).toHaveBeenCalledOnce();
      expect(anyHandler).toHaveBeenCalledOnce();
      expect(anyHandler).toHaveBeenCalledWith('ping');
    });
  });

  // -------------------------------------------------------------------------
  // listenerCount
  // -------------------------------------------------------------------------
  describe('listenerCount', () => {
    it('returns correct count', () => {
      expect(bus.listenerCount('user:login')).toBe(0);

      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.on('user:login', h1);
      expect(bus.listenerCount('user:login')).toBe(1);

      bus.on('user:login', h2);
      expect(bus.listenerCount('user:login')).toBe(2);

      bus.off('user:login', h1);
      expect(bus.listenerCount('user:login')).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // removeAllListeners
  // -------------------------------------------------------------------------
  describe('removeAllListeners', () => {
    it('clears everything including onAny handlers', () => {
      const handler = vi.fn();
      const anyHandler = vi.fn();
      bus.on('user:login', handler);
      bus.onAny(anyHandler);
      bus.removeAllListeners();

      bus.emit('user:login', 'u-1', 123);

      expect(handler).not.toHaveBeenCalled();
      expect(anyHandler).not.toHaveBeenCalled();
      expect(bus.listenerCount('user:login')).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // multiple handlers on same event
  // -------------------------------------------------------------------------
  describe('multiple handlers', () => {
    it('all fire for the same event', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      const h3 = vi.fn();
      bus.on('order:created', h1);
      bus.on('order:created', h2);
      bus.on('order:created', h3);

      bus.emit('order:created', 'ord-1', 50, 'EUR');

      expect(h1).toHaveBeenCalledWith('ord-1', 50, 'EUR');
      expect(h2).toHaveBeenCalledWith('ord-1', 50, 'EUR');
      expect(h3).toHaveBeenCalledWith('ord-1', 50, 'EUR');
    });
  });
});
