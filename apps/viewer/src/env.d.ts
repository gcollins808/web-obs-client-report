// Build-time settings read from the project's .env files (vite.report.config.ts: envDir + envPrefix).
interface ImportMetaEnv {
  /** Default address for client feedback. A per-report address set in the studio wins. */
  readonly WEBOBS_FEEDBACK_TO?: string;
  /** Subject template; {client} becomes the client's name. */
  readonly WEBOBS_FEEDBACK_SUBJECT?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }

/** Version and build time, set at build (vite.report.config.ts). */
declare const __BUILD_STAMP__: string;

/** The agency brand chosen at build time (vite.report.config.ts, apps/viewer/brand). null = the built-in look. Presentation text and one colour only. */
declare const __WEBOBS_BRAND__: { name: string; header: string; footer: string; accent: string; headingCase: string; titleText: string } | null;
