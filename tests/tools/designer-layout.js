'use strict';

/**
 * Measures the Designer's property pane in a real browser.
 *
 * The suite has no layout engine -- the stub DOM has no widths -- so "does everything fit?" has always been
 * answered by reading the stylesheet. This asks Chromium instead: it builds the panel the way the extension
 * does, clicks every control in the Toolbox in turn, and reports where the property pane's content is wider
 * than the pane (which is exactly the horizontal scrollbar the user has to drag to reach a field).
 *
 * Manual, and needs a browser:
 *
 *   cd tests/tmp && mkdir -p layout && cd layout
 *   PUPPETEER_CACHE_DIR=../puppeteer-cache npm install puppeteer
 *   PUPPETEER_CACHE_DIR=../puppeteer-cache npx puppeteer browsers install chrome
 *   node ../../tools/designer-layout.js                      # the sheet in out/
 *   node ../../tools/designer-layout.js <path-to-styles.js>   # any other compiled sheet, to compare
 *
 * The second form is how the CSS was checked: the same run against the installed extension's compiled
 * `out/designer/styles.js` from before a fix shows the rows that used to run off the side.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const puppeteerRoot = path.join(repoRoot, 'tests', 'tmp', 'layout', 'node_modules', 'puppeteer');
const puppeteer = require(puppeteerRoot);

const compiled = (module) => require(path.join(repoRoot, 'out', module.replace(/\.js$/, '')));

const VIEWPORTS = [
    { name: 'wide', width: 1280, height: 860 },
    { name: 'medium', width: 1000, height: 760 },
    { name: 'narrow', width: 820, height: 680 },
    { name: 'small', width: 640, height: 640 },
];

function pageHtml(styles) {
    const bundle = fs.readFileSync(path.join(repoRoot, 'out', 'webview', 'designer.js'), 'utf8');
    return `<!doctype html>
<html><head><meta charset="utf-8"><style>${styles}</style></head>
<body><div id="designer"></div>
<script>
window.__posted = [];
window.acquireVsCodeApi = () => ({
    postMessage: (message) => window.__posted.push(message),
    getState: () => undefined,
    setState: () => {},
});
</script>
<script>${bundle}</script>
</body></html>`;
}

/** The overflow of both panes, and the elements that stick out of them.
 *
 * One self-contained function, because `page.evaluate` sends only what it is given to the browser: a helper
 * defined beside it in this file would not exist there.
 */
function measureBothPanes() {
    const measure = (selector) => {
        const pane = document.querySelector(selector);
        const paneRect = pane.getBoundingClientRect();
        const offenders = [];
        for (const element of pane.querySelectorAll('*')) {
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) {
                continue;
            }
            if (rect.right > paneRect.right + 0.5 || rect.left < paneRect.left - 0.5) {
                offenders.push({
                    element: `${element.tagName.toLowerCase()}.${element.className || '(none)'}`,
                    text: (element.textContent || '').trim().slice(0, 24),
                    left: Math.round(rect.left),
                    right: Math.round(rect.right),
                    width: Math.round(rect.width),
                });
            }
        }
        return {
            clientWidth: pane.clientWidth,
            scrollWidth: pane.scrollWidth,
            viewport: window.innerWidth,
            paneRight: Math.round(paneRect.right),
            bodyRight: Math.round(document.querySelector('.body').getBoundingClientRect().right),
            offenders,
        };
    };
    return { properties: measure('.properties'), toolbox: measure('.toolbox') };
}

/** Every control the toolbox offers, so the run covers every property kind the catalogue has. */
function toolboxLabels() {
    return [...document.querySelectorAll('.toolbox-item')].map((item) =>
        (item.textContent || '').replace(/\s*\*$/, '').trim(),
    );
}

function clickToolboxItem(label) {
    const item = [...document.querySelectorAll('.toolbox-item')].find(
        (candidate) => (candidate.textContent || '').replace(/\s*\*$/, '').trim() === label,
    );
    if (item === undefined) {
        throw new Error(`no toolbox item called ${label}`);
    }
    item.click();
}

async function main() {
    const override = process.argv[2];
    const styles = override === undefined
        ? compiled('designer/styles').designerStyles()
        : require(path.resolve(override)).designerStyles();
    const label = override === undefined ? 'out/designer/styles.js' : override;

    const starterDocument = compiled('designer/generate').starterDocument;
    const document_ = starterDocument({
        boardId: 'sunton-3248s035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
    });
    document_.fonts = [{ id: 'title', src: 'assets/title.bdf', chars: 'AB' }];

    // A short scratch directory outside the checkout, on purpose: Chromium puts its process-singleton socket in
    // `$TMPDIR` and refuses to start when that path is longer than about a hundred characters, which any path
    // inside a deep worktree is. Everything it needs to write goes here.
    const scratch = process.env.DESIGNER_LAYOUT_SCRATCH ?? '/tmp/dsh-designer-layout';
    fs.mkdirSync(path.join(scratch, 'home'), { recursive: true });

    const browser = await puppeteer.launch({
        headless: true,
        userDataDir: path.join(scratch, 'profile'),
        args: [
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-crash-reporter',
        ],
        env: { ...process.env, TMPDIR: scratch, HOME: path.join(scratch, 'home') },
    });
    let bad = 0;
    let checked = 0;
    try {
        for (const viewport of VIEWPORTS) {
            const page = await browser.newPage();
            await page.setViewport({ width: viewport.width, height: viewport.height });
            await page.setContent(pageHtml(styles), { waitUntil: 'load' });
            await page.evaluate((init) => {
                window.dispatchEvent(new MessageEvent('message', { data: init }));
            }, {
                type: 'init',
                document: document_,
                canvas: { width: 480, height: 320 },
                paths: { document: 'designer/panel.ui.json', kdl: 'src/ui.kdl' },
                touchBoard: true,
                touchEnabled: true,
            });

            const labels = await page.evaluate(toolboxLabels);
            const states = ['(screen, nothing selected)', ...labels];
            console.log(`\n== ${label} at ${viewport.width}x${viewport.height}`);
            for (const state of states) {
                if (state !== '(screen, nothing selected)') {
                    await page.evaluate(clickToolboxItem, state);
                }
                const panes = await page.evaluate(measureBothPanes);
                checked += 1;
                const result = panes.properties;
                const over = result.scrollWidth - result.clientWidth;
                const toolboxOver = panes.toolbox.scrollWidth - panes.toolbox.clientWidth;
                if (over > 0 || toolboxOver > 0) {
                    bad += 1;
                }
                console.log(
                    `   ${over > 0 ? 'OVERFLOW' : 'fits    '} ${String(over).padStart(4)}px  `
                    + `scroll ${result.scrollWidth} / client ${result.clientWidth}  ${state}`
                    + (over > 0 && result.offenders.length > 0
                        ? `\n            first: ${JSON.stringify(result.offenders.slice(0, 3))}`
                        : '')
                    + (toolboxOver > 0
                        ? `\n            toolbox also overflows by ${toolboxOver}px: `
                            + JSON.stringify(panes.toolbox.offenders.slice(0, 2))
                        : ''),
                );
            }
            await page.close();
        }
    } finally {
        await browser.close();
    }
    console.log(`\n${bad} of ${checked} states overflowed a pane (the property pane is listed above, the Toolbox beside it).`);
    process.exitCode = bad === 0 ? 0 : 1;
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 2;
});
