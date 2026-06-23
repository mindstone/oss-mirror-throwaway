import { describe, it, expect } from 'vitest';
import { resolveSendMessageOptions } from '../resolveSendMessageOptions';

describe('resolveSendMessageOptions', () => {
  it('hides and stamps origin when only receiptText is provided', () => {
    const result = resolveSendMessageOptions({ receiptText: 'Approved' });
    expect(result).toEqual({ shouldHide: true, messageOrigin: 'system-continuation' });
  });

  it('hides and stamps origin when only options.isHidden is true', () => {
    const result = resolveSendMessageOptions({ options: { isHidden: true } });
    expect(result).toEqual({ shouldHide: true, messageOrigin: 'system-continuation' });
  });

  it('hides and stamps origin when both receiptText and options.isHidden are set', () => {
    const result = resolveSendMessageOptions({ receiptText: 'Saved', options: { isHidden: true } });
    expect(result).toEqual({ shouldHide: true, messageOrigin: 'system-continuation' });
  });

  it('receiptText takes precedence: explicit isHidden false does NOT downgrade receipt-hide', () => {
    const result = resolveSendMessageOptions({ receiptText: 'Memory saved', options: { isHidden: false } });
    expect(result).toEqual({ shouldHide: true, messageOrigin: 'system-continuation' });
  });

  it('returns no hide and no origin when neither signal is present', () => {
    const result = resolveSendMessageOptions({});
    expect(result).toEqual({ shouldHide: false, messageOrigin: undefined });
  });
});
