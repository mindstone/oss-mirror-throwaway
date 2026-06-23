#!/usr/bin/env node
/**
 * Fetches the latest tag from the rebel-system GitHub repo and updates package.json.
 * Run this before building/packaging to ensure the app uses the latest rebel system.
 * 
 * Usage: node scripts/update-rebel-system-version.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');

async function fetchLatestTag(repo, token) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${repo}/tags?per_page=1`,
            method: 'GET',
            headers: {
                'User-Agent': 'rebel-app-Build',
                'Accept': 'application/vnd.github.v3+json',
                ...(token && { 'Authorization': `Bearer ${token}` })
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`GitHub API returned ${res.statusCode}: ${data}`));
                    return;
                }
                try {
                    const tags = JSON.parse(data);
                    if (!tags.length) {
                        reject(new Error('No tags found in repository'));
                        return;
                    }
                    // Tags are returned in order, first is latest
                    // Remove 'v' prefix if present
                    const latestTag = tags[0].name.replace(/^v/, '');
                    resolve(latestTag);
                } catch (e) {
                    reject(new Error(`Failed to parse GitHub response: ${e.message}`));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

async function main() {
    // Read current package.json
    const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

    if (!packageJson.systemSettings) {
        console.error('Error: package.json does not have systemSettings configuration');
        process.exit(1);
    }

    const { repo, token } = packageJson.systemSettings;

    if (!repo) {
        console.error('Error: systemSettings.repo not configured in package.json');
        process.exit(1);
    }

    console.log(`Fetching latest tag from ${repo}...`);

    try {
        const latestVersion = await fetchLatestTag(repo, token);
        const currentVersion = packageJson.systemSettings.version;

        if (currentVersion === latestVersion) {
            console.log(`Rebel system version already at latest: ${latestVersion}`);
            return;
        }

        console.log(`Updating rebel system version: ${currentVersion} -> ${latestVersion}`);

        // Update package.json
        packageJson.systemSettings.version = latestVersion;
        fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(packageJson, null, 2) + '\n');

        console.log('package.json updated successfully');
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
}

main();
