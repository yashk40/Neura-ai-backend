const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const PORT = 4000;

// Enable CORS
app.use(cors());
app.use(express.json());

// In-memory storage for requests
const requests = new Map();

// Thinking mode toggle (default: 'on' means don't skip, 'off' means skip)
let thinkingMode = 'on';

// Delay helper
async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to wait for and click Skip Thinking button
async function waitAndClickSkipButton(page, requestId) {
    const maxWaitTime = 20000; // 20 seconds
    const checkInterval = 500; // Check every 500ms
    const startTime = Date.now();

    while ((Date.now() - startTime) < maxWaitTime) {
        try {
            // Search for the Skip Thinking button
            const skipButton = await page.evaluate(() => {
                // Look for div with aria-label="Skip Thinking"
                const skipDiv = document.querySelector('div[aria-label="Skip Thinking"]');
                if (skipDiv) {
                    // Find the button inside it
                    const button = skipDiv.querySelector('button');
                    if (button) {
                        return true;
                    }
                }
                return false;
            });

            if (skipButton) {
                // Click the button
                await page.evaluate(() => {
                    const skipDiv = document.querySelector('div[aria-label="Skip Thinking"]');
                    if (skipDiv) {
                        const button = skipDiv.querySelector('button');
                        if (button) {
                            button.click();
                        }
                    }
                });
                return true; // Button found and clicked
            }
        } catch (error) {
            console.log(`[${requestId}] Error while searching for Skip button:`, error.message);
        }

        // Wait before next check
        await delay(checkInterval);
    }

    return false; // Button not found within 20 seconds
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
            // userDataDir: path.join(__dirname, 'user_data'),
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

        const context = browser.defaultBrowserContext();
        await context.overridePermissions('https://chat.z.ai', ['clipboard-read', 'clipboard-write']);

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');

        // Auto-login with provided token
        const AUTH_TOKEN = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjAyY2UwYWY0LWZmZTUtNGFmOS04MzliLWMyYmFiMDc2MWI2MCIsImVtYWlsIjoieWt1bWF3YXQwMDZAZ21haWwuY29tIn0.MpMjS3vwVPo_K8iU5cvV6NuxcKTGtaUckCsHgGY9th7SaGQqhqoayRwJSFMJiYOcP9-uM41bgEmSTPay6XuK8Q";

        console.log(`[${requestId}] Injecting auth token...`);
        try {
            // Navigate to the domain first to set localStorage/cookies
            await page.goto('https://chat.z.ai/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

            await page.evaluate((token) => {
                localStorage.setItem('token', token);
                localStorage.setItem('access_token', token);
                // Try setting common cookie names as well just in case
                document.cookie = `token=${token}; path=/; domain=.chat.z.ai; secure; samesite=strict`;
                document.cookie = `access_token=${token}; path=/; domain=.chat.z.ai; secure; samesite=strict`;
            }, AUTH_TOKEN);

            console.log(`[${requestId}] Token injected.`);
        } catch (e) {
            console.warn(`[${requestId}] Failed to inject token (non-fatal):`, e.message);
        }

        console.log(`[${requestId}] Navigating to chat.z.ai...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // Wait for input and send
        const inputSel = 'textarea#chat-input, textarea[placeholder*="Message"], textarea';
        // Increased timeout to 2 minutes (120000ms) to allow for manual login if needed
        await page.waitForSelector(inputSel, { timeout: 120000 });

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

        // Auto-skip thinking if mode is 'off'
        if (thinkingMode === 'off') {
            console.log(`[${requestId}] Thinking mode is OFF - searching for Skip button...`);
            const skipFound = await waitAndClickSkipButton(page, requestId);
            if (skipFound) {
                console.log(`[${requestId}] Skip button clicked successfully`);
            } else {
                console.log(`[${requestId}] Skip button not found after 20 seconds`);
            }
        }

        // Wait for generation to complete
        console.log(`[${requestId}] Waiting for response...`);
        let generationComplete = false;
        const maxWaitTime = 900000; // 5 minutes
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

// Endpoint: Get response (no id = send response.txt; with id = get request by id)
app.get('/response', (req, res) => {
    const { id } = req.query;

    if (!id) {
        const filePath = path.join(__dirname, 'response.txt');
        if (!fs.existsSync(filePath)) return res.status(404).send('response.txt not found');
        return res.type('text/plain').send(fs.readFileSync(filePath, 'utf8'));
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

// Endpoint: Send component.txt
app.get('/component', (req, res) => {
    const filePath = path.join(__dirname, 'component.txt');
    if (!fs.existsSync(filePath)) return res.status(404).send('component.txt not found');
    return res.type('text/plain').send(fs.readFileSync(filePath, 'utf8'));
});

// Endpoint: Toggle thinking mode
app.get('/thinking', (req, res) => {
    const { mode } = req.query;

    // If no mode parameter, show HTML interface
    if (!mode) {
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Thinking Mode Toggle</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .container {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 500px;
            width: 100%;
            text-align: center;
        }
        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 2rem;
        }
        .status {
            margin: 30px 0;
            padding: 20px;
            border-radius: 12px;
            font-size: 1.1rem;
        }
        .status.on {
            background: #e3f2fd;
            color: #1976d2;
            border: 2px solid #1976d2;
        }
        .status.off {
            background: #fff3e0;
            color: #f57c00;
            border: 2px solid #f57c00;
        }
        .status strong {
            font-size: 1.5rem;
            display: block;
            margin-bottom: 10px;
        }
        .buttons {
            display: flex;
            gap: 15px;
            margin-top: 30px;
        }
        .btn {
            flex: 1;
            padding: 15px 30px;
            border: none;
            border-radius: 10px;
            font-size: 1.1rem;
            font-weight: 600;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
            transition: all 0.3s ease;
            color: white;
        }
        .btn-on {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .btn-on:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 25px rgba(102, 126, 234, 0.4);
        }
        .btn-off {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
        }
        .btn-off:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 25px rgba(245, 87, 108, 0.4);
        }
        .btn.active {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .info {
            margin-top: 30px;
            padding: 15px;
            background: #f5f5f5;
            border-radius: 10px;
            font-size: 0.9rem;
            color: #666;
            text-align: left;
        }
        .info strong {
            color: #333;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 Thinking Mode Control</h1>
        <div class="status ${thinkingMode}">
            <strong>${thinkingMode === 'on' ? '🧠 Thinking Mode: ON' : '⚡ Thinking Mode: OFF'}</strong>
            <p>${thinkingMode === 'on'
                ? 'Skip button will NOT be clicked automatically'
                : 'Skip button will be clicked automatically within 20 seconds'}</p>
        </div>
        
        <div class="buttons">
            <a href="/thinking?mode=on" class="btn btn-on ${thinkingMode === 'on' ? 'active' : ''}">
                Turn ON
            </a>
            <a href="/thinking?mode=off" class="btn btn-off ${thinkingMode === 'off' ? 'active' : ''}">
                Turn OFF
            </a>
        </div>
        
        <div class="info">
            <strong>ℹ️ How it works:</strong><br>
            • <strong>ON:</strong> Bot will show thinking process (slower, more detailed)<br>
            • <strong>OFF:</strong> Bot will skip thinking (faster, auto-clicks Skip button)<br>
            • The "Skip Thinking" button will be searched for 20 seconds
        </div>
    </div>
</body>
</html>
        `;
        return res.send(html);
    }

    // Handle mode toggle
    if (mode !== 'on' && mode !== 'off') {
        return res.status(400).json({
            error: 'Invalid mode. Use ?mode=on or ?mode=off',
            currentMode: thinkingMode
        });
    }

    thinkingMode = mode;
    console.log(`✓ Thinking mode set to: ${thinkingMode.toUpperCase()}`);

    // Redirect back to the main interface
    res.redirect('/thinking');
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'Code Generation API',
        endpoints: {
            '/prompt': 'Submit a prompt (GET with ?prompt=your-prompt-here)',
            '/response': 'Get response.txt (GET) or generated code (GET with ?id=request-id)',
            '/component': 'Get component.txt (GET)',
            '/thinking': 'Toggle thinking mode (GET with ?mode=on or ?mode=off)'
        },
        currentThinkingMode: thinkingMode
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`✓ Server running on http://localhost:${PORT}`);
    console.log(`✓ Submit prompts: http://localhost:${PORT}/prompt?prompt=your-prompt-here`);
    console.log(`✓ Get responses: http://localhost:${PORT}/response?id=request-id`);
    console.log(`✓ Toggle thinking mode: http://localhost:${PORT}/thinking`);
});
