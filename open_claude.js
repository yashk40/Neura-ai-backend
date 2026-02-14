const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const getConfig = () => {
    const arg = process.argv[2];
    if (arg) {
        if (arg.startsWith('http') && arg.includes('prompt=')) {
            try {
                const u = new URL(arg);
                return { url: arg, prompt: u.searchParams.get('prompt') };
            } catch (_) { }
        }
        return { url: 'https://chat.z.ai/', prompt: arg };
    }
    const envPrompt = process.env.PROMPT;
    if (envPrompt) return { url: 'https://chat.z.ai/', prompt: envPrompt };
    return { url: 'https://chat.z.ai/', prompt: null };
};

(async () => {
    let { url, prompt } = getConfig();
    if (prompt && !url.includes('prompt=')) {
        url = `${url.replace(/\/$/, '')}?prompt=${encodeURIComponent(prompt)}`;
    }

    console.log('Target URL:', url);
    if (!prompt) {
        console.log('No prompt provided → type manually in browser');
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            //    executablePath:"/usr/bin/google-chrome",
            headless: false,
            defaultViewport: null,
            args: [
                // '--start-maximized',
                // '--no-sandbox',
                // '--disable-setuid-sandbox'
                // // '--start-maximized',
                // // '--no-sandbox',
                // // '--disable-setuid-sandbox'
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage"
            ]
        });

        // Grant clipboard permissions automatically
        const context = browser.defaultBrowserContext();
        await context.overridePermissions('https://chat.z.ai', ['clipboard-read', 'clipboard-write']);

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');

        // Auto-login with provided token
        const AUTH_TOKEN = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjAyY2UwYWY0LWZmZTUtNGFmOS04MzliLWMyYmFiMDc2MWI2MCIsImVtYWlsIjoieWt1bWF3YXQwMDZAZ21haWwuY29tIn0.MpMjS3vwVPo_K8iU5cvV6NuxcKTGtaUckCsHgGY9th7SaGQqhqoayRwJSFMJiYOcP9-uM41bgEmSTPay6XuK8Q";

        console.log('Injecting auth token...');
        try {
            await page.goto('https://chat.z.ai/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

            await page.evaluate((token) => {
                localStorage.setItem('token', token);
                localStorage.setItem('access_token', token);
                document.cookie = `token=${token}; path=/; domain=.chat.z.ai; secure; samesite=strict`;
                document.cookie = `access_token=${token}; path=/; domain=.chat.z.ai; secure; samesite=strict`;
            }, AUTH_TOKEN);

            console.log('Token injected.');
        } catch (e) {
            console.warn('Failed to inject token (non-fatal):', e.message);
        }

        console.log('Navigating...');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // If prompt was given via URL or argument
        let promptToUse = prompt;
        if (!promptToUse) {
            promptToUse = await page.evaluate(() =>
                new URLSearchParams(window.location.search).get('prompt')
            );
        }

        if (promptToUse) {
            console.log('Waiting for input field...');
            const inputSel = 'textarea#chat-input, textarea[placeholder*="Message"], textarea[placeholder*="help"], textarea';
            await page.waitForSelector(inputSel, { timeout: 40000 });

            console.log('Typing prompt...');
            await page.click(inputSel);
            await page.evaluate((text) => {
                const el = document.querySelector('textarea#chat-input, textarea[placeholder*="Message"], textarea');
                if (el) el.value = text;
            }, promptToUse);
            await page.type(inputSel, ' ', { delay: 1 });
            await delay(300);

            console.log('Sending (Enter)...');
            await page.keyboard.press('Enter');
        } else {
            console.log('Waiting for you to send the message manually...');
        }

        console.log('Waiting for AI response...');
        await delay(5000);

        // Wait for generation to complete
        console.log('Monitoring generation completion...');
        let generationComplete = false;
        const maxWaitTime = 900000; // 15 minutes
        const startTime = Date.now();

        // Look for the loading dots to disappear
        while (!generationComplete && (Date.now() - startTime) < maxWaitTime) {
            generationComplete = await page.evaluate(() => {
                // Check if the loading dots container is gone
                const loadingDots = document.querySelector('.container.svelte-1devy8o');
                if (loadingDots && window.getComputedStyle(loadingDots).display !== 'none') {
                    return false; // Still loading
                }

                // Check if iframe with srcdoc exists (means response is ready)
                const iframe = document.querySelector('iframe[srcdoc]');
                if (iframe) {
                    return true; // Found iframe with content
                }

                return false;
            });

            if (!generationComplete) {
                console.log('Still generating...');
                await delay(3000);
            }
        }

        console.log('Generation complete! Extracting response...');
        await delay(3000); // Extra wait to ensure rendering

        // Extract the AI's response from iframe srcdoc
        let finalCode = '';

        finalCode = await page.evaluate(() => {
            // Find iframe with srcdoc attribute
            const iframe = document.querySelector('iframe[srcdoc]');

            if (!iframe) {
                return 'ERROR: Could not find iframe with srcdoc';
            }

            // Get the srcdoc content
            let srcdoc = iframe.getAttribute('srcdoc');

            if (!srcdoc) {
                return 'ERROR: Iframe has no srcdoc attribute';
            }

            // Decode HTML entities
            const textarea = document.createElement('textarea');
            textarea.innerHTML = srcdoc;
            const decodedContent = textarea.value;

            // The srcdoc contains a wrapper, extract the actual HTML from inside
            // Look for the inner <html> tag (the actual generated code)
            const innerHtmlMatch = decodedContent.match(/<html lang="en">[\s\S]*?<\/html>/i);
            if (innerHtmlMatch) {
                return innerHtmlMatch[0];
            }

            // If no match, try to get full DOCTYPE declaration
            const doctypeMatch = decodedContent.match(/<!DOCTYPE html>[\s\S]*?<\/html>/i);
            if (doctypeMatch) {
                return doctypeMatch[0];
            }

            // Fallback: return decoded srcdoc
            return decodedContent;
        });

        // Save debug files
        const debugHTML = await page.content();
        fs.writeFileSync(path.join(__dirname, 'debug_page.html'), debugHTML, 'utf8');
        console.log('Saved debug_page.html');

        if (!finalCode || finalCode.length < 100 || finalCode.startsWith('ERROR:')) {
            console.log('ERROR: Extraction failed');
            console.log('Result:', finalCode);

            // Screenshot for debugging
            await page.screenshot({
                path: path.join(__dirname, 'extraction_failed.png'),
                fullPage: true
            });
            console.log('Screenshot saved as extraction_failed.png');
            return;
        }

        // Final cleanup - decode any remaining HTML entities
        finalCode = finalCode
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim();

        // Save
        const timestamp = Date.now();
        const filename = `generated_${timestamp}.html`;
        const outPath = path.join(__dirname, filename);

        fs.writeFileSync(outPath, finalCode, 'utf8');

        console.log('╔════════════════════════════════════════════╗');
        console.log('║         CODE SAVED SUCCESSFULLY            ║');
        console.log('║ File:     ', outPath);
        console.log('║ Length:   ', finalCode.length, 'characters');
        console.log('╚════════════════════════════════════════════╝');

        console.log('\nFirst 700 characters:\n' + finalCode.slice(0, 700));
        console.log('\n...\n');
        console.log('Last 400 characters:\n' + finalCode.slice(-400));

    } catch (err) {
        console.error('ERROR:', err.message);
        console.error(err.stack || err);
    }

    console.log('\nBrowser remains open. You can check manually if needed.');
})();