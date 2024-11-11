const express = require('express');
const puppeteer = require('puppeteer');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { spawn } = require('child_process');
const fs = require('fs').promises;

// setup
const app = express();
const PORT = 3000;

dotenv.config();
app.use(bodyParser.json());

let browserInstance = null;
let isLoggedIn = false;

app.listen(PORT, (error) =>{
    if(!error)
        console.log("Server is successfully running, and app is listening on port: "+ PORT)
    else 
        console.log("Error occurred, server can't start", error);
    }
);

app.post('/api/content', async (req, res) => {
    const { url } = req.body;
    
    if (!url.includes('instagram.com')) {
        return res.status(400).json({ error: 'Invalid Instagram URL' });
    }

    const isReel = url.includes('/reel/');
    console.log(`Content type: ${isReel? 'Reel' : 'Post'}`);

    try {
        const browserInstance = await initBrowser();
        const page = await browserInstance.newPage();
        await loginToInstagram(page);

        console.log("Loading URL: " + url);
        await page.goto(url);

        // Wait for navigation after going to URL
        await Promise.all([
            page.goto(url),
            page.waitForSelector('body', { visible: true })
        ]);

        console.log("Waiting for content...");

        // Log current URL and title
        console.log("Current URL:", await page.url());
        console.log("Page title:", await page.title());

        const content = await extractMediaContent(page, isReel);

        console.log("Sending media")
        res.writeHead(200, {
            'Content-Type': content.contentType,
            'Content-Length': content.data.length
        });
        res.end(content.data);

        console.log("Done!");

        await page.close();
    } catch (error) {
        console.error('Screenshot error:', error);
        res.status(500).json({ error: 'Failed to capture content' });
    }
});

async function initBrowser() {
    if (!browserInstance) {
        try {
            console.log("Launching new browser instance")
            browserInstance = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox']
            });
        } catch (e) {
            console.error("Failed to launch browser instance, saw error: " + e.message);
        }
        
    }

    return browserInstance;
}

async function loginToInstagram(page) {
    if (isLoggedIn) {
        console.log("Already logged into instagram")
        return;
    }

    console.log("Logging into instagram");

    await page.goto('https://www.instagram.com/accounts/login/');  
    await page.waitForSelector('input[name="username"]');

    await page.type('input[name="username"]', process.env.INSTAGRAM_USERNAME);
    await page.type('input[name="password"]', process.env.INSTAGRAM_PASSWORD);

    await page.click('button[type="submit"]');

    await page.waitForNavigation(); // Wait for redirect after login
    const currentUrl = page.url();
    if (currentUrl.includes('instagram.com/accounts/login')) {
        // Still on login page = probably failed
        throw new Error('Login failed - still on login page');
    }

    try {
        // Wait for an element that appears on successful login
        await page.waitForSelector('svg[aria-label="Home"]', { timeout: 5000 });
        console.log('Login successful - found home icon');
        isLoggedIn = true;
    } catch (e) {
        throw new Error('Login failed - could not find home icon');
    }
}

async function extractMediaContent(page, isReel) {
    try {
        if (isReel) {

            console.log("Loading reel...");
            await page.setRequestInterception(true);
            let videoUrl = null;
            let audioUrl = null;

            page.on('request', request => {
                const url = request.url();
                if (url.includes('.mp4')) {
                    // Parse byte range from URL
                    const byteMatch = url.match(/bytestart=(\d+)&byteend=(\d+)/)
                    const efgMatch = url.match(/efg=([^&]+)/);
                    if (byteMatch && efgMatch) {
                        const efg = decodeURIComponent(efgMatch[1]);
                        const decoded = JSON.parse(atob(efg));

                        if (decoded.vencode_tag.includes('_audio')) {
                            if (!audioUrl) {
                                console.log('Found audio stream: ', url)
                                audioUrl = url.split('&bytestart=')[0];
                            }
                        } else {
                            if (!videoUrl) {
                                console.log('Found video url: ', url);
                                videoUrl = url.split('&bytestart=')[0];
                            }
                        }
                    }
                }
                request.continue();
            });

            await page.waitForSelector('video', { timeout: 60000 });
            // wait enough time for all requests to come in.
            await new Promise(r => setTimeout(r, 2000));

            if (!videoUrl && !audioUrl) {
                throw new Error(`Missing either video or audio URL. Video URL: ${videoUrl}. Audio URL: ${audioUrl}`);
            }

            console.log("Downloading video...");
            const videoUrlDownload = videoUrl + "&bytestart=0";
            const videoResponse = await fetch(videoUrlDownload, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
                    'Referer': 'https://www.instagram.com/'
                }
            });

            const videoBuffer = await videoResponse.buffer();
            console.log("Downloaded video");

            console.log("Downloading audio...")
            const audioUrlDownload = audioUrl + "&bytestart=0";
            const audioResponse = await fetch(audioUrlDownload, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
                    'Referer': 'https://www.instagram.com/'
                }
            });
            const audioBuffer = await audioResponse.buffer();
            console.log("Downloaded audio");

            console.log("Combining audio and video...");
            // save temporarily
            await fs.writeFile('temp_video.mp4', videoBuffer);
            await fs.writeFile('temp_audio.mp4', audioBuffer); 

            await new Promise((resolve, reject) => {
                const ffmpeg = spawn('ffmpeg', [
                    '-i', 'temp_video.mp4',
                    '-i', 'temp_audio.mp4',
                    '-c:v', 'copy',
                    '-c:a', 'copy',
                    'output.mp4'
                ]);
            
                // Handle stdout data
                ffmpeg.stdout.on('data', (data) => {
                    console.log(`ffmpeg stdout: ${data}`);
                });

                // Handle stderr data (ffmpeg uses this for progress info too)
                ffmpeg.stderr.on('data', (data) => {
                    console.log(`ffmpeg stderr: ${data}`);
                });

                // Handle successful completion
                ffmpeg.on('close', (code) => {
                    if (code === 0) {
                        console.log('FFmpeg process completed successfully');
                        resolve();
                    } else {
                        reject(new Error(`FFmpeg process exited with code ${code}`));
                    }
                });

                // Handle errors
                ffmpeg.on('error', (err) => {
                    console.error('Failed to start FFmpeg process:', err);
                    reject(err);
                });
            });

            console.log("Done combining video.")
            const finalVideo = await fs.readFile('output.mp4');
            await fs.unlink('temp_video.mp4');
            await fs.unlink('temp_audio.mp4');
            await fs.unlink('output.mp4');

            return {
                type: 'video',
                data: finalVideo,
                contentType: 'video/mp4'
            };


            //// TRIAL 3
            // console.log("Loading reel...");
            // await page.setRequestInterception(true);

            // // Store video URLs we find
            // let videoUrls = [];

            // // Listen for requests
            // page.on('request', request => {
            //     // Log and store video requests
            //     if (request.resourceType() === 'media') {
            //         console.log('Found video URL:', request.url());
            //         videoUrls.push(request.url());
            //     }
            //     request.continue();
            // });

            // await page.waitForSelector('video', { timeout: 60000 });
            // await new Promise(r => setTimeout(r, 2000));  // Wait for requests to be captured

            // if (videoUrls.length === 0) {
            //     throw new Error('No video URLs found');
            // }

            // // Get the first video URL (usually the main content)
            // const videoUrl = videoUrls[0];
            // console.log('Using video URL:', videoUrl);

            // // Now fetch the video using node-fetch
            // const response = await fetch(videoUrl, {
            //     headers: {
            //         'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
            //         'Referer': 'https://www.instagram.com/'
            //     }
            // });

            // if (!response.ok) {
            //     throw new Error(`Failed to fetch video: ${response.status} ${response.statusText}`);
            // }

            // const buffer = await response.buffer();
            // return {
            //     type: 'video',
            //     data: buffer,
            //     contentType: 'video/mp4'
            // };

            // // TRIAL 2
            // console.log("Loading reel...");

            // // wait for video element to appear
            // await page.waitForSelector('video');

            // // get video data directly from the page
            // const videoBuffer = await page.evaluate(async () => {
            //     const videoElement = document.querySelector('video');
            //     const blobUrl = videoElement.src;

            //     // fetch the blob URL within the page context
            //     const response = await fetch(blobUrl);
            //     const blob = await response.blob();

            //     // Convert blob to base64
            //     return new Promise((resolve) => {
            //         const reader = new FileReader();
            //         reader.onloadend = () => resolve(reader.result);
            //         reader.readAsDataURL(blob);
            //     });
            // })

            // // Convert base64 back to buffer
            // const base64Data = videoBuffer.split(',')[1];
            // const buffer = Buffer.from(base64Data, 'base64');

            // return {
            //     type: 'video',
            //     data: buffer,
            //     contentType: 'video/mp4'
            // };

            // // TRIAL 1
            // // get video URL
            // const videoUrl = await page.evaluate(() => {
            //     const videoElement = document.querySelector('video');
            //     const sourceElement = videoElement.querySelector('source') || videoElement;
            //     return sourceElement.src || videoElement.src;
            // });

            // if (videoUrl) {
            //     console.log("Found video URL:", videoUrl);
            //     console.log("Downloading...");
                
            //     // Download video using node-fetch
            //     const response = await fetch(videoUrl);
            //     const buffer = await response.buffer();
                
            //     return {
            //         type: 'video',
            //         data: buffer,
            //         contentType: 'video/mp4'
            //     };
            // }
        } else {
            console.log("Loading post...")
            await Promise.all([
                // let's wait for the time data to show up
                page.waitForSelector('time'),
                page.waitForSelector('img[src]:not([src=""])', { timeout: 60000 }),
            ]);

            console.log("Taking screenshot...");
            const screenshot = await page.screenshot({
                type: 'png',
                fullPage: true
            });

            return {
                type: 'image',
                data: screenshot,
                contentType: 'image/png'
            }
        }
    } catch (e) {
        console.log(`Error loading/downloading content: ${e.message}`)
        throw e;
    }
}