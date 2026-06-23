import { describe, expect, it } from 'vitest';
import * as rootBarrel from '../../index';
import * as chatControllerBarrel from '../index';
import * as chatControllerReact from '../react';

describe('shared embedded chat barrel guards', () => {
  it('keeps chat runtime APIs out of the root barrel', () => {
    expect(rootBarrel).not.toHaveProperty('chatController');
    expect(rootBarrel).not.toHaveProperty('intentClient');
    expect(rootBarrel).not.toHaveProperty('chatUI');
  });

  it('keeps @rebel/shared/chatController React-free', () => {
    expect(chatControllerBarrel).not.toHaveProperty('useChatController');
    expect(chatControllerReact).toHaveProperty('useChatController');
  });
});
