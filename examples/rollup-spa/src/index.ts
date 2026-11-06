import 'gt-react/macros'; // attaches the global t`...` macro (see src/App.tsx)
import { initializeGTSPA } from 'gt-react';
import gtConfig from '../gt.config.json';
import loadTranslations from './loadTranslations';

// The project ID is inlined at build time by @rollup/plugin-replace (see
// rollup.config.mjs). In this plain-Rollup setup gt-react always resolves to
// its production runtime in the browser, so it never fetches on-the-fly
// translations and takes no API key; the committed src/_gt/*.json files cover
// every locale and an empty project ID is fine.
await initializeGTSPA({
  ...gtConfig,
  projectId: process.env.GT_PROJECT_ID,
  loadTranslations,
});

await import('./main');
