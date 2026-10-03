import * as https from 'https';

/**
 * Minimal HTTPS GET returning text. No `vscode` dependency, and no third-party client.
 *
 * The Library Manager needs two endpoints: the crates.io sparse index (plain text, one JSON
 * document per line) and the crates.io search API (JSON). Both require a User-Agent that
 * identifies the caller, so it is set here rather than at each call site.
 */

export interface HttpTextResponse {
    status: number;
    body: string;
}

export type HttpGetText = (url: string, headers?: Record<string, string>) => Promise<HttpTextResponse>;

export const USER_AGENT = 'grumpy-rusty-platform (VS Code extension)';

export function httpGetText(url: string, headers: Record<string, string> = {}, redirects = 0): Promise<HttpTextResponse> {
    return new Promise((resolve, reject) => {
        if (redirects > 5) {
            reject(new Error(`Too many redirects while fetching ${url}`));
            return;
        }
        const request = https.get(
            url,
            {
                headers: {
                    'User-Agent': USER_AGENT,
                    // Identity so the sparse index does not need gunzip; the payload is small.
                    'Accept-Encoding': 'identity',
                    Accept: 'application/json, text/plain, */*',
                    ...headers,
                },
            },
            (response) => {
                const status = response.statusCode ?? 0;
                if (status >= 300 && status < 400 && response.headers.location) {
                    response.resume();
                    const next = new URL(response.headers.location, url).toString();
                    httpGetText(next, headers, redirects + 1).then(resolve).catch(reject);
                    return;
                }
                let body = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => (body += chunk));
                response.on('end', () => resolve({ status, body }));
            },
        );
        request.setTimeout(20_000, () => {
            request.destroy(new Error(`Timed out fetching ${url}`));
        });
        request.on('error', reject);
    });
}
