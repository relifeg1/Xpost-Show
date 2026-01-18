const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const axios = require('axios'); // تأكد أنك حذفت سطر clipboardy من هنا

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
    theme: 'chunky', 
    showAvatar: true, showName: true, showMedia: true, 
    showStats: true, showDate: true, scale: 1.0,
    defaultDuration: 10
};

// --- دوال الحفظ والاسترجاع السحابية ---

async function loadDatabase() {
    try {
        console.log("☁️ جاري الاتصال بـ JSONBlob...");
        const res = await axios.get(API_URL);
        const data = res.data;
        if (data) {
            if (data.queue) queue = data.queue;
            if (data.settings) globalSettings = data.settings;
            console.log(`✅ تم استرجاع ${queue.length} تغريدة.`);
            updateAdmin();
        }
    } catch (e) {
        console.error("⚠️ فشل استرجاع البيانات:", e.message);
    }
}

async function saveDatabase() {
    try {
        const payload = {
            queue: queue,
            settings: globalSettings,
            updatedAt: new Date().toISOString()
        };
        await axios.put(API_URL, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        console.log("💾 تم الحفظ السحابي.");
    } catch (e) {
        console.error("❌ فشل الحفظ:", e.message);
    }
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
    const finalSettings = { ...globalSettings, ...(tweet.customSettings || {}) };

    io.emit('show_tweet', { 
        data: tweet, index: currentIndex + 1, total: queue.length, settings: finalSettings
    });
    updateAdmin();

    if (autoState.active) {
        clearTimeout(autoState.timer);
        const duration = (tweet.customDuration || globalSettings.defaultDuration) * 1000;
        autoState.timer = setTimeout(() => {
            showTweet((currentIndex + 1) % queue.length);
        }, duration);
    }
}

async function processAdd(url, res) {
    const idMatch = url && url.match(/(?:twitter|x)\.com\/.*\/status\/(\d+)/);
    if (idMatch && idMatch[1]) {
        // التحقق من التكرار
        if (queue.find(t => t.id_str === idMatch[1])) {
            return res.send ? res.send("Already Exists") : res.json({ success: false, msg: 'موجودة مسبقاً' });
        }
        try {
            const resp = await axios.get(`https://cdn.syndication.twimg.com/tweet-result?id=${idMatch[1]}&token=x`);
            queue.push({ ...resp.data, customSettings: null, customDuration: null });
            
            updateAdmin();
            saveDatabase();
            
            return res.send ? res.send("Added") : res.json({ success: true });
        } catch (e) { 
            return res.send ? res.send("Error Fetching") : res.status(500).json({ error: 'فشل الجلب' }); 
        }
    } else {
        return res.send ? res.send("Invalid Link") : res.status(400).json({ error: 'رابط خطأ' });
    }
}

// --- APIs ---

app.post('/api/add', async (req, res) => {
    // تم إلغاء النسخ التلقائي هنا
    let url = req.body.url;
    if (url) {
        await processAdd(url, res);
    } else {
        res.status(400).json({ error: 'No URL provided' });
    }
});

app.post('/api/control', (req, res) => {
    const { action, index } = req.body;
    if (action === 'show') showTweet(index);
    else if (action === 'next') showTweet((currentIndex + 1) % queue.length);
    else if (action === 'prev') showTweet((currentIndex - 1 + queue.length) % queue.length);
    else if (action === 'toggle_auto') {
        autoState.active = !autoState.active;
        if (autoState.active) {
            if (currentIndex === -1) showTweet(0); else showTweet(currentIndex);
        } else {
            clearTimeout(autoState.timer); updateAdmin();
        }
    }
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
    saveDatabase();
    updateAdmin();
    res.json({ success: true });
});

app.post('/api/settings', (req, res) => {
    globalSettings = { ...globalSettings, ...req.body };
    io.emit('state_update', { settings: globalSettings });
    if (currentIndex !== -1) showTweet(currentIndex);
    saveDatabase();
    res.json({ success: true });
});

// Stream Deck Links
// تم تعديل رابط الإضافة ليخبرك باستخدام الأدمن بدلاً من التسبب في خطأ
app.get('/trigger_add', (req, res) => { res.send("Use Admin Page to Add"); });
app.get('/trigger_next', (req, res) => { if(queue.length){ showTweet((currentIndex + 1) % queue.length); res.send("Next"); } else res.send("Empty"); });
app.get('/trigger_prev', (req, res) => { if(queue.length){ showTweet((currentIndex - 1 + queue.length) % queue.length); res.send("Prev"); } else res.send("Empty"); });
app.get('/trigger_auto', (req, res) => { autoState.active = !autoState.active; if(autoState.active) (currentIndex===-1?showTweet(0):showTweet(currentIndex)); else { clearTimeout(autoState.timer); updateAdmin(); } res.send(autoState.active?"Auto ON":"Auto OFF"); });
app.get('/hide', (req, res) => { io.emit('hide_tweet'); clearTimeout(autoState.timer); autoState.active = false; updateAdmin(); res.send('Hidden'); });

// رابط الفحص
app.get('/debug-save', async (req, res) => {
    try {
        const readRes = await axios.get(API_URL);
        res.send(`<h1>✅ System Online</h1><p>Theme: ${globalSettings.theme}</p>`);
    } catch (e) {
        res.status(500).send(`❌ Error: ${e.message}`);
    }
});

io.on('connection', (s) => updateAdmin());

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));