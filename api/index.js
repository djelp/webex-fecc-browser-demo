// Vercel serverless entry: static files in public/ are served by Vercel's CDN;
// every other path (/auth/*, /api/*, device macro endpoints) is rewritten here.
export { app as default } from "../server.js";
