import { describe, it, expect } from 'vitest';
import { InputHandler } from '../src/input-handler.js';

describe('InputHandler', () => {
  it('shouldAutoRespond returns true by default', () => {
    const handler = new InputHandler();
    expect(handler.shouldAutoRespond()).toBe(true);
  });

  it('shouldAutoRespond returns false when disabled', () => {
    const handler = new InputHandler(false);
    expect(handler.shouldAutoRespond()).toBe(false);
  });

  it('getAutoResponse returns expected string', () => {
    const handler = new InputHandler();
    expect(handler.getAutoResponse()).toBe(
      'This is a non-interactive session. Please proceed with your best judgment.',
    );
  });
});
