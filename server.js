const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// 🔥 إعدادات الحفظ (JSONBlob) 🔥
const BLOB_ID = '019bcdd9-7c76-7d01-a193-def55c292a99'; 
const API_URL = `https://jsonblob.com/api/jsonBlob/${BLOB_ID}`;

let queue = [];
let currentIndex = -1;
let autoState = { active: false, timer: null };

let globalSettings = { 
    theme: 'classic', showAvatar: true, showName: true, showUsername: true,
    showMedia: true, showDate: true, playSound: true, defaultDuration: 15
};

// --- التحميل والحفظ ---
async function loadDatabase() {
    try {
        const res = await axios.get(API_URL);
        const data = res.data;
        if (data) {
            if (data.queue) queue = data.queue;
            if (data.settings) globalSettings = { ...globalSettings, ...data.settings };
            updateAdmin();
        }
    } catch (e) { console.error("⚠️ خطأ تحميل:", e.message); }
}

async function saveDatabase() {
    try {
        const payload = { queue, settings: globalSettings, updatedAt: new Date().toISOString() };
        await axios.put(API_URL, payload, { headers: { 'Content-Type': 'application/json' } });
    } catch (e) { console.error("❌ خطأ الحفظ:", e.message); }
}

loadDatabase();

function updateAdmin() {
    io.emit('state_update', { 
        queue, current: currentIndex, isAuto: autoState.active, settings: globalSettings 
    });
}

function showTweet(index) {
    if (index < 0 || index >= queue.length) return;
    currentIndex = index;
    const tweet = queue[currentIndex];
    
    const finalSettings = { ...globalSettings, theme: tweet.customSettings?.theme || globalSettings.theme };

    io.emit('show_tweet', { 
        data: tweet, index: currentIndex + 1, total: queue.length, 
        settings: finalSettings, isPinned: tweet.customSettings?.pinned || false, 
        isBreaking: tweet.customSettings?.breaking || false
    });
    updateAdmin();

    if (autoState.active) {
        clearTimeout(autoState.timer);
        if (tweet.customSettings?.pinned) return;
        const duration = (tweet.customDuration || globalSettings.defaultDuration) * 1000;
        autoState.timer = setTimeout(() => { showTweet((currentIndex + 1) % queue.length); }, duration);
    }
}

// --- معالجة الإضافة السريعة ---
async function processAdd(req, res) {
    let newItem = null;

    if (req.body.mode === 'custom') {
        newItem = {
            type: 'custom', id_str: 'custom_' + Date.now(), text: req.body.text,
            user: { name: req.body.title || 'مخصص', screen_name: 'ZairuDuo', profile_image_url_https: req.body.image || 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png' },
            created_at: new Date().toISOString(), mediaDetails: req.body.mediaUrl ? [{ media_url_https: req.body.mediaUrl, type: 'photo' }] : [],
            customSettings: { theme: req.body.theme || 'classic', pinned: false, breaking: false },
            customDuration: req.body.duration ? parseInt(req.body.duration) : null
        };
    } else if (req.body.url) {
        const idMatch = req.body.url.match(/(?:twitter|x)\.com\/.*\/status\/(\d+)/);
        if (!idMatch) return res.status(400).json({ error: 'رابط غير صحيح' });
        if (queue.find(t => t.id_str === idMatch[1])) return res.json({ success: false, msg: 'موجود مسبقاً' });

        try {
            const resp = await axios.get(`https://cdn.syndication.twimg.com/tweet-result?id=${idMatch[1]}&token=x`);
            newItem = { 
                ...resp.data, type: 'tweet',
                customSettings: { theme: req.body.theme || 'classic', pinned: false, breaking: false }, 
                customDuration: req.body.duration ? parseInt(req.body.duration) : null
            };
        } catch (e) { return res.status(500).json({ error: 'فشل جلب التغريدة' }); }
    }

    if (newItem) {
        queue.push(newItem);
        // 🔥 التعديل الجوهري: تحديث الأدمن فوراً قبل الحفظ 🔥
        updateAdmin(); 
        res.json({ success: true }); 
        saveDatabase(); // الحفظ في الخلفية
    }
}

// --- APIs ---

app.post('/api/add', processAdd);

app.post('/api/edit_tweet', (req, res) => {
    const { index, theme, duration, togglePin, toggleBreaking, newTitle, newText } = req.body;
    if (queue[index]) {
        if (!queue[index].customSettings) queue[index].customSettings = {};
        if (theme) queue[index].customSettings.theme = theme;
        if (duration !== undefined) queue[index].customDuration = duration ? parseInt(duration) : null;
        if (togglePin) queue[index].customSettings.pinned = !queue[index].customSettings.pinned;
        if (toggleBreaking) queue[index].customSettings.breaking = !queue[index].customSettings.breaking;
        if (newTitle !== undefined) queue[index].user.name = newTitle;
        if (newText !== undefined) queue[index].text = newText;
        
        updateAdmin(); // تحديث فوري
        res.json({ success: true });
        saveDatabase(); // حفظ خلفي
        if (currentIndex === index) showTweet(index);
    } else res.json({ success: false });
});

app.post('/api/settings', (req, res) => {
    globalSettings = { ...globalSettings, ...req.body };
    io.emit('state_update', { settings: globalSettings });
    res.json({ success: true });
    saveDatabase();
    if (currentIndex !== -1) showTweet(currentIndex);
});

app.post('/api/control', (req, res) => {
    const { action, index } = req.body;
    if (action === 'show') showTweet(index);
    else if (action === 'next') showTweet((currentIndex + 1) % queue.length);
    else if (action === 'prev') showTweet((currentIndex - 1 + queue.length) % queue.length);
    else if (action === 'toggle_auto') {
        autoState.active = !autoState.active;
        if (autoState.active) { currentIndex === -1 ? showTweet(0) : showTweet(currentIndex); } 
        else { clearTimeout(autoState.timer); updateAdmin(); }
    }
    else if (action === 'hide') { io.emit('hide_tweet'); clearTimeout(autoState.timer); autoState.active = false; updateAdmin(); }
    res.json({ success: true });
});

app.post('/api/manage', (req, res) => {
    const { action, index } = req.body;
    if (action === 'delete') {
        queue.splice(index, 1);
        if (queue.length === 0) { currentIndex = -1; io.emit('hide_tweet'); clearTimeout(autoState.timer); autoState.active = false; }
        else if (index === currentIndex) showTweet(index % queue.length);
        else if (index < currentIndex) currentIndex--;
    }
    // 🔥 منطق الترتيب الجديد 🔥
    else if (action === 'move_up' && index > 0) {
        [queue[index], queue[index - 1]] = [queue[index - 1], queue[index]];
        if(currentIndex === index) currentIndex--; else if(currentIndex === index-1) currentIndex++;
    }
    else if (action === 'move_down' && index < queue.length - 1) {
        [queue[index], queue[index + 1]] = [queue[index + 1], queue[index]];
        if(currentIndex === index) currentIndex++; else if(currentIndex === index+1) currentIndex--;
    }
    else if (action === 'clear') { queue = []; currentIndex = -1; io.emit('hide_tweet'); clearTimeout(autoState.timer); autoState.active = false; }
    
    updateAdmin();
    res.json({ success: true });
    saveDatabase();
});

// Helper Routes
app.get('/trigger_next', (req, res) => { if(queue.length){ showTweet((currentIndex+1)%queue.length); res.send("Next"); } else res.send("Empty"); });
app.get('/trigger_prev', (req, res) => { if(queue.length){ showTweet((currentIndex-1+queue.length)%queue.length); res.send("Prev"); } else res.send("Empty"); });
app.get('/trigger_auto', (req, res) => { autoState.active = !autoState.active; if(autoState.active) (currentIndex===-1?showTweet(0):showTweet(currentIndex)); else { clearTimeout(autoState.timer); updateAdmin(); } res.send(autoState.active?"Auto ON":"Auto OFF"); });
app.get('/hide', (req, res) => { io.emit('hide_tweet'); clearTimeout(autoState.timer); autoState.active = false; updateAdmin(); res.send('Hidden'); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server Ready on ${PORT}`));