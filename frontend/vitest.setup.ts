import { expect, vi } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

// Provide Jest-compatible globals for existing tests that rely on jest.fn
(globalThis as any).jest = vi;
