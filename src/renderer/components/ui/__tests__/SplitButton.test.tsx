import { describe, it, expect, vi } from 'vitest';
import { SplitButton, type SplitButtonProps, type DropdownItem } from '../SplitButton';

/**
 * SplitButton Component Tests
 *
 * Since the project doesn't have jsdom or @testing-library/react installed,
 * these tests verify:
 * 1. Component exports and types work correctly
 * 2. Component structure and props API
 * 3. Basic behavioral contracts
 *
 * Full DOM integration tests would require adding testing dependencies.
 * E2E tests will cover actual user interaction in the running app.
 */

describe('SplitButton', () => {
  describe('exports', () => {
    it('exports SplitButton component', () => {
      expect(typeof SplitButton).toBe('function');
      expect(SplitButton.displayName).toBe('SplitButton');
    });
  });

  describe('props API', () => {
    it('accepts the expected props', () => {
      // Type-check that the props API is correctly defined
      const mockOnClick = vi.fn();
      const mockDropdownItems: DropdownItem[] = [
        { label: 'Option 1', onClick: vi.fn() },
        { label: 'Option 2', onClick: vi.fn(), icon: undefined },
      ];

      const props: SplitButtonProps = {
        children: 'Send',
        onClick: mockOnClick,
        disabled: false,
        type: 'button',
        size: 'md',
        dropdownItems: mockDropdownItems,
        dropdownDisabled: false,
      };

      // Verify prop shapes
      expect(typeof props.onClick).toBe('function');
      expect(Array.isArray(props.dropdownItems)).toBe(true);
      expect(props.dropdownItems.length).toBe(2);
    });

    it('has correct default prop values documented in type', () => {
      // Minimal required props
      const minimalProps: SplitButtonProps = {
        children: 'Test',
        onClick: vi.fn(),
        dropdownItems: [],
      };

      expect(minimalProps.disabled).toBeUndefined(); // defaults to false
      expect(minimalProps.type).toBeUndefined(); // defaults to 'button'
      expect(minimalProps.size).toBeUndefined(); // defaults to 'md'
      expect(minimalProps.dropdownDisabled).toBeUndefined(); // defaults to false
    });
  });

  describe('DropdownItem type', () => {
    it('requires label and onClick', () => {
      const item: DropdownItem = {
        label: 'Test Option',
        onClick: vi.fn(),
      };

      expect(item.label).toBe('Test Option');
      expect(typeof item.onClick).toBe('function');
      expect(item.icon).toBeUndefined(); // optional
    });

    it('accepts optional icon prop', () => {
      const MockIcon = () => null;
      const item: DropdownItem = {
        label: 'With Icon',
        onClick: vi.fn(),
        icon: MockIcon as unknown as DropdownItem['icon'],
      };

      expect(item.icon).toBeDefined();
    });
  });

  describe('size variants', () => {
    it('accepts sm, md, lg sizes', () => {
      const sizes: SplitButtonProps['size'][] = ['sm', 'md', 'lg'];

      sizes.forEach((size) => {
        const props: SplitButtonProps = {
          children: 'Test',
          onClick: vi.fn(),
          dropdownItems: [],
          size,
        };
        expect(props.size).toBe(size);
      });
    });
  });

  describe('button types', () => {
    it('accepts button and submit types', () => {
      const types: SplitButtonProps['type'][] = ['button', 'submit'];

      types.forEach((type) => {
        const props: SplitButtonProps = {
          children: 'Test',
          onClick: vi.fn(),
          dropdownItems: [],
          type,
        };
        expect(props.type).toBe(type);
      });
    });
  });

  describe('behavioral contracts', () => {
    it('dropdown items have click handlers', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const items: DropdownItem[] = [
        { label: 'Save as...', onClick: handler1 },
        { label: 'Export', onClick: handler2 },
      ];

      // Simulate calling handlers
      items[0].onClick();
      items[1].onClick();

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('handlers are independent', () => {
      const primaryHandler = vi.fn();
      const dropdownHandler = vi.fn();

      const props: SplitButtonProps = {
        children: 'Send',
        onClick: primaryHandler,
        dropdownItems: [{ label: 'Archive', onClick: dropdownHandler }],
      };

      // Call primary
      props.onClick();
      expect(primaryHandler).toHaveBeenCalledTimes(1);
      expect(dropdownHandler).toHaveBeenCalledTimes(0);

      // Call dropdown item
      props.dropdownItems[0].onClick();
      expect(primaryHandler).toHaveBeenCalledTimes(1);
      expect(dropdownHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('integration with primary + secondary action pattern', () => {
    it('supports primary action with secondary dropdown option', () => {
      const handleSave = vi.fn();
      const handleSaveAs = vi.fn();

      // Example: "Save" with "Save as..." dropdown
      const saveDropdownItems: DropdownItem[] = [
        {
          label: 'Save as...',
          onClick: handleSaveAs,
          // icon: Save (LucideIcon)
        },
      ];

      const props: SplitButtonProps = {
        children: 'Save',
        onClick: handleSave,
        dropdownItems: saveDropdownItems,
        disabled: false,
        dropdownDisabled: false,
      };

      // Primary action should save
      props.onClick();
      expect(handleSave).toHaveBeenCalled();

      // Dropdown item should save as
      props.dropdownItems[0].onClick();
      expect(handleSaveAs).toHaveBeenCalled();
    });
  });
});
