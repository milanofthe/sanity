/// <reference types="svelte" />

// Vite's asset and style imports. Declared here rather than pulling in
// vite/client, which would also drag in types this project does not use.
declare module '*.css';
declare module '*.png' {
  const src: string;
  export default src;
}
