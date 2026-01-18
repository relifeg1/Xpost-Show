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

// الإعدادات العامة
let globalSettings = { 
    theme: 'classic', 
    showAvatar: true, showName: true, showUsername: true,
    showMedia: true, showDate: true, playSound: true,
    defaultDuration: 15
};

async function loadDatabase() {
    try {
        const res = await axios.get(API_URL);
        const data = res.data;
        if (data) {
            if (data.queue) queue = data.queue;
            if (data.settings) globalSettings = { ...globalSettings, ...data.settings };
            updateAdmin();
        }
    } catch (e) { console.error("⚠️ خطأ تحميل البيانات:", e.message); }
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
    
    const finalSettings = { 
        ...globalSettings, 
        theme: tweet.customSettings?.theme || globalSettings.theme
    };

    io.emit('show_tweet', { 
        data: tweet, 
        index: currentIndex + 1, 
        total: queue.length, 
        settings: finalSettings,
        isPinned: tweet.customSettings?.pinned || false,
        isBreaking: tweet.customSettings?.breaking || false
    });
    updateAdmin();

    // إدارة المؤقت التلقائي
    if (autoState.active) {
        clearTimeout(autoState.timer);
        
        // 🛑 إذا كان الخبر مثبتاً (Pinned)، لا نشغل المؤقت 🛑
        if (tweet.customSettings?.pinned) {
            console.log("📌 الخبر مثبت: توقف المؤقت التلقائي مؤقتاً.");
            return; 
        }

        const duration = (tweet.customDuration || globalSettings.defaultDuration) * 1000;
        autoState.timer = setTimeout(() => { showTweet((currentIndex + 1) % queue.length); }, duration);
    }
}

// إضافة تغريدة (رابط)
async function processAddUrl(url, theme, duration, res) {
    const idMatch = url && url.match(/(?:twitter|x)\.com\/.*\/status\/(\d+)/);
    if (idMatch && idMatch[1]) {
        if (queue.find(t => t.id_str === idMatch[1])) return res.json({ success: false, msg: 'موجود مسبقاً' });
        try {
            const resp = await axios.get(`https://cdn.syndication.twimg.com/tweet-result?id=${idMatch[1]}&token=x`);
            const newTweet = { 
                ...resp.data, 
                type: 'tweet',
                customSettings: { theme: theme || 'classic', pinned: false, breaking: false }, 
                customDuration: duration ? parseInt(duration) : null
            };
            queue.push(newTweet);
            saveAndRespond(res);
        } catch (e) { res.status(500).json({ error: 'خطأ في جلب التغريدة' }); }
    } else { res.status(400).json({ error: 'رابط غير صحيح' }); }
}

// إضافة بطاقة مخصصة (Custom Card)
function processAddCustom(data, res) {
    const newCard = {
        type: 'custom',
        id_str: 'custom_' + Date.now(),
        text: data.text,
        user: {
            name: data.title || 'خبر مخصص',
            screen_name: 'ZairuDuo',
            profile_image_url_https: data.image || 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png'
        },
        created_at: new Date().toISOString(),
        mediaDetails: data.mediaUrl ? [{ media_url_https: data.mediaUrl, type: 'photo' }] : [],
        customSettings: { theme: data.theme || 'classic', pinned: false, breaking: false },
        customDuration: data.duration ? parseInt(data.duration) : null
    };
    queue.push(newCard);
    saveAndRespond(res);
}

function saveAndRespond(res) {
    updateAdmin();
    saveDatabase();
    res.json({ success: true });
}

// --- APIs ---

app.post('/api/add', async (req, res) => {
    // التمييز بين إضافة رابط وإضافة بطاقة مخصصة
    if (req.body.mode === 'custom') {
        processAddCustom(req.body, res);
    } else {
        if (req.body.url) await processAddUrl(req.body.url, req.body.theme, req.body.duration, res);
        else res.status(400).json({ error: 'No URL' });
    }
});

app.post('/api/edit_tweet', (req, res) => {
    const { index, theme, duration, togglePin, toggleBreaking } = req.body;
    if (queue[index]) {
        if (!queue[index].customSettings) queue[index].customSettings = {};
        
        if (theme) queue[index].customSettings.theme = theme;
        if (duration !== undefined) queue[index].customDuration = duration ? parseInt(duration) : null;
        if (togglePin) queue[index].customSettings.pinned = !queue[index].customSettings.pinned;
        if (toggleBreaking) queue[index].customSettings.breaking = !queue[index].customSettings.breaking;
        
        saveDatabase();
        // إذا تغير شيء مؤثر (مثل التثبيت) والخبر معروض، نعيد تحديث العرض
        if (currentIndex === index) showTweet(index); else updateAdmin();
    }
    res.json({ success: true });
});

app.post('/api/settings', (req, res) => {
    globalSettings = { ...globalSettings, ...req.body };
    io.emit('state_update', { settings: globalSettings });
    saveDatabase();
    if (currentIndex !== -1) showTweet(currentIndex);
    res.json({ success: true });
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
    if (action === 'clear') { queue = []; currentIndex = -1; io.emit('hide_tweet'); clearTimeout(autoState.timer); autoState.active = false; }
    saveDatabase(); updateAdmin(); res.json({ success: true });
});

// Stream Deck Helper
app.get('/trigger_next', (req, res) => { if(queue.length){ showTweet((currentIndex+1)%queue.length); res.send("Next"); } else res.send("Empty"); });
app.get('/trigger_prev', (req, res) => { if(queue.length){ showTweet((currentIndex-1+queue.length)%queue.length); res.send("Prev"); } else res.send("Empty"); });
app.get('/trigger_auto', (req, res) => { autoState.active = !autoState.active; if(autoState.active) (currentIndex===-1?showTweet(0):showTweet(currentIndex)); else { clearTimeout(autoState.timer); updateAdmin(); } res.send(autoState.active?"Auto ON":"Auto OFF"); });
app.get('/hide', (req, res) => { io.emit('hide_tweet'); clearTimeout(autoState.timer); autoState.active = false; updateAdmin(); res.send('Hidden'); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Pro Server Ready on ${PORT}`));