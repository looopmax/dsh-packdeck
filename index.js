// Packdeck — conventional entry alias.
//
// The Loader resolves this package through `package.json` `exports["."]`, which points at
// `entry.js` (the Host half). This file exists so tools and readers that expect `index.js`
// still find the plugin, and so the module URL the Loader imports stays stable when the entry
// implementation is replaced (a cached ESM URL is never re-evaluated in a running Host).
//
// Keep the implementation in `entry.js`; do not add logic here.
export * from './entry.js';
