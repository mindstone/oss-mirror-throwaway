import { setFooProvider } from '../../src/core/fooProvider';

// CROSS_SURFACE_PARITY_EXEMPT: cloud has no safeStorage-backed key; intentional stub until parity lands
setFooProvider(() => false);
