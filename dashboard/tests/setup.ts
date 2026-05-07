import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement window.scrollTo and TanStack Router's
// scroll-restoration code calls it on every navigation, producing
// "Not implemented" stderr noise. Stub it as a no-op for tests.
window.scrollTo = () => {};
