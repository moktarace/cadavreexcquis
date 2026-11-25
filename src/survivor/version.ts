declare const __BUILD_COMMIT__: string;
declare const __BUILD_TIME__: string;

/** SHA et date de la compilation (injectés par vite.config.ts); « dev » hors compilation. */
export const BUILD_COMMIT: string = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'dev';
export const BUILD_TIME: string = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : '';

export const shortCommit = (sha: string = BUILD_COMMIT) => (sha.length > 7 ? `${sha.slice(0, 7)}${sha.includes('+') ? '+local' : ''}` : sha);
