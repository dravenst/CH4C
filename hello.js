//import { existsSync } from 'node:fs';
//import path from 'path';
//import os from 'os';

console.log("Hello World")
/*
// https://chromium.googlesource.com/chromium/src.git/+/HEAD/docs/user_data_dir.md
var linuxChromeDirectories = [
    path.join(os.homedir(), '.config', 'google-chrome'),
    path.join(os.homedir(), '.config', 'google-chrome-beta'),
    path.join(os.homedir(), '.config', 'google-chrome-unstable'),
    path.join(os.homedir(), '.config', 'chromium'),
]

var macChromeDirectories = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome Beta'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome Canary'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Chromium'),
]

var winChromeDirectories = [
    path.join(os.homedir(), 'Google', 'Chrome', 'User Data'),
    path.join(os.homedir(), 'Google', 'Chrome Beta', 'User Data'),
    path.join(os.homedir(), 'Google', 'Chrome SxS', 'User Data'),
    path.join(os.homedir(), 'Chromium', 'User Data'),
]

const chromeDirectories = {
    'darwin': macChromeDirectories,
    'win32': winChromeDirectories,
    'linux': linuxChromeDirectories,
}

function findDirectoryThatExists(directoryArray) {
    for (const dir of directoryArray) {
        if (existsSync(dir)) return dir
    }
    return null
}

var dataDir = findDirectoryThatExists(chromeDirectories[process.platform])
*/
/*
function findDataDir() {
    switch (process.platform) {
        case 'darwin':
            return  findDirectoryThatExists(macChromeDirectories)
        case 'win32':
            return findDirectoryThatExists(winChromeDirectories)
        case'linux':
            return findDirectoryThatExists(linuxChromeDirectories)
    }
}
*/
//console.log('Chrome data path:', dataDir)