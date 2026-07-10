// Bun.build bundles plain .css imports into the page stylesheet
// (build-app.ts collects every emitted css chunk); teach tsc the same.
declare module "*.css";
