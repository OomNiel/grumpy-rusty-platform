import * as fs from 'fs';
import * as https from 'https';

/** Minimal HTTPS downloader with redirect handling. No `vscode` dependency. */

export function downloadFile(url: string, destination: string, redirects = 0): Promise<void> {
    return new Promise((resolve, reject) => {
        if (redirects > 5) {
            reject(new Error(`Too many redirects while downloading ${url}`));
            return;
        }
        https
            .get(url, { headers: { 'User-Agent': 'grumpy-rusty-platform' } }, (response) => {
                const status = response.statusCode ?? 0;
                if (status >= 300 && status < 400 && response.headers.location) {
                    response.resume();
                    downloadFile(new URL(response.headers.location, url).toString(), destination, redirects + 1)
                        .then(resolve)
                        .catch(reject);
                    return;
                }
                if (status !== 200) {
                    response.resume();
                    reject(new Error(`HTTP ${status} downloading ${url}`));
                    return;
                }
                const file = fs.createWriteStream(destination);
                response.pipe(file);
                file.on('finish', () => file.close(() => resolve()));
                file.on('error', reject);
            })
            .on('error', reject);
    });
}
