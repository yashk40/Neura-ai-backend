const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const puppeteer = require('puppeteer');

const app = express();
const PORT = 4000;

// Enable CORS
app.use(cors());
app.use(express.json());

// In-memory storage for requests
const requests = new Map();

// Delay helper
async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Core extraction function
async function generateCode(prompt, requestId) {
    const url = `https://chat.z.ai/?prompt=${encodeURIComponent(prompt)}`;
    let browser;

    try {
        // Update status
        requests.set(requestId, { status: 'processing', code: null, prompt });

        browser = await puppeteer.launch({
            executablePath:"/usr/bin/google-chrome",
            headless: true,
            defaultViewport: null,
            args: [
                '--start-maximized',
                '--no-sandbox',
                '--disable-setuid-sandbox'
            ]
        });

        const context = browser.defaultBrowserContext();
        await context.overridePermissions('https://chat.z.ai', ['clipboard-read', 'clipboard-write']);

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');

        console.log(`[${requestId}] Navigating to chat.z.ai...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // Wait for input and send
        const inputSel = 'textarea#chat-input, textarea[placeholder*="Message"], textarea';
        await page.waitForSelector(inputSel, { timeout: 40000 });

        console.log(`[${requestId}] Typing prompt...`);
        await page.click(inputSel);
        await page.evaluate((text) => {
            const el = document.querySelector('textarea#chat-input, textarea[placeholder*="Message"], textarea');
            if (el) el.value = text;
        }, prompt);
        await page.type(inputSel, ' ', { delay: 1 });
        await delay(300);

        console.log(`[${requestId}] Sending prompt...`);
        await page.keyboard.press('Enter');

        await delay(5000);

        // Wait for generation to complete
        console.log(`[${requestId}] Waiting for response...`);
        let generationComplete = false;
        const maxWaitTime = 300000; // 5 minutes
        const startTime = Date.now();

        while (!generationComplete && (Date.now() - startTime) < maxWaitTime) {
            generationComplete = await page.evaluate(() => {
                const loadingDots = document.querySelector('.container.svelte-1devy8o');
                if (loadingDots && window.getComputedStyle(loadingDots).display !== 'none') {
                    return false;
                }
                const iframe = document.querySelector('iframe[srcdoc]');
                return !!iframe;
            });

            if (!generationComplete) {
                await delay(3000);
            }
        }

        console.log(`[${requestId}] Extracting code...`);
        await delay(3000);

        // Extract from iframe
        const finalCode = await page.evaluate(() => {
            const iframe = document.querySelector('iframe[srcdoc]');
            if (!iframe) return null;

            let srcdoc = iframe.getAttribute('srcdoc');
            if (!srcdoc) return null;

            // Decode HTML entities
            const textarea = document.createElement('textarea');
            textarea.innerHTML = srcdoc;
            const decodedContent = textarea.value;

            // Extract inner HTML
            const innerHtmlMatch = decodedContent.match(/<html lang="en">[\s\S]*?<\/html>/i);
            if (innerHtmlMatch) return innerHtmlMatch[0];

            const doctypeMatch = decodedContent.match(/<!DOCTYPE html>[\s\S]*?<\/html>/i);
            if (doctypeMatch) return doctypeMatch[0];

            return decodedContent;
        });

        if (!finalCode || finalCode.length < 100) {
            throw new Error('Extraction failed: code too short or empty');
        }

        // Clean up
        const cleanedCode = finalCode
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim();

        // Update with success
        requests.set(requestId, {
            status: 'ready',
            code: cleanedCode,
            prompt,
            completedAt: new Date().toISOString()
        });

        console.log(`[${requestId}] ✓ Code generated successfully (${cleanedCode.length} chars)`);

        await browser.close();

    } catch (error) {
        console.error(`[${requestId}] Error:`, error.message);
        requests.set(requestId, {
            status: 'error',
            code: null,
            prompt,
            error: error.message
        });

        if (browser) {
            await browser.close();
        }
    }
}

// Endpoint: Submit prompt
app.get('/prompt', async (req, res) => {
    const { prompt } = req.query;

    if (!prompt) {
        return res.status(400).json({ error: 'Prompt parameter is required' });
    }

    const requestId = uuidv4();

    // Start generation in background
    generateCode(prompt, requestId);

    res.json({
        status: 'processing',
        id: requestId,
        message: 'Request submitted. Use the ID to check the response.'
    });
});

// Endpoint: Get response
app.get('/response', (req, res) => {
    const { id } = req.query;

    if (!id) {
        return res.status(400).json({ error: 'ID parameter is required' });
    }

    const request = requests.get(id);

    if (!request) {
        return res.status(404).json({ error: 'Request not found' });
    }

    if (request.status === 'processing') {
        return res.json({
            status: 'processing',
            message: 'Code is still being generated. Please try again in a few seconds.'
        });
    }

    if (request.status === 'error') {
        return res.status(500).json({
            status: 'error',
            error: request.error
        });
    }

    // Return the generated code
    res.json({
        status: 'ready',
        code: request.code,
        prompt: request.prompt,
        completedAt: request.completedAt
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'Code Generation API',
        endpoints: {
            '/prompt': 'Submit a prompt (GET with ?prompt=your-prompt-here)',
            '/response': 'Get generated code (GET with ?id=request-id)'
        }
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`✓ Server running on http://localhost:${PORT}`);
    console.log(`✓ Submit prompts: http://localhost:${PORT}/prompt?prompt=your-prompt-here`);
    console.log(`✓ Get responses: http://localhost:${PORT}/response?id=request-id`);
});
