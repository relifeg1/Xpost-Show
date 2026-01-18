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
    showAvatar: true, showName: true, showMedia: true, 
    showStats: true, showDate: true, scale: 1.0, 
    defaultDuration: 10
};

// تحميل البيانات
async function loadDatabase() {
    try {
        const res = await axios.get(API_URL);
        const data = res.data;
        if (data && data.queue) {
            queue = data.queue;
            updateAdmin();
        }
    } catch (e) { console.error("⚠️ خطأ تحميل البيانات:", e.message); }
}

// حفظ البيانات
async function saveDatabase() {
    try {
        const payload = { queue, settings: globalSettings, updatedAt: new Date().toISOString() };
        await axios.put(API_URL, payload, { headers: { 'Content-Type': 'application/json' } });
    } catch (e) { console.error("❌ خطأ الحفظ:", e.message); }
}

loadDatabase();

function updateAdmin() {
    io.emit('state_update', { queue, current: currentIndex, isAuto: autoState.active, settings: globalSettings });
}

function showTweet(index) {
    if (index < 0 || index >= queue.length) return;
    currentIndex = index;
    const tweet = queue[currentIndex];
    
    // دمج إعدادات التغريدة الخاصة (الثيم) مع الإعدادات العامة
    const finalSettings = { ...globalSettings, ...(tweet.customSettings || {}) };

    io.emit('show_tweet', { 
        data: tweet, index: currentIndex + 1, total: queue.length, settings: finalSettings
    });
    updateAdmin();

    if (autoState.active) {
        clearTimeout(autoState.timer);
        const duration = (tweet.customDuration || globalSettings.defaultDuration) * 1000;
        autoState.timer = setTimeout(() => { showTweet((currentIndex + 1) % queue.length); }, duration);
    }
}

// إضافة تغريدة جديدة مع الثيم المختار
async function processAdd(url, theme, res) {
    const idMatch = url && url.match(/(?:twitter|x)\.com\/.*\/status\/(\d+)/);
    if (idMatch && idMatch[1]) {
        if (queue.find(t => t.id_str === idMatch[1])) {
            return res.send ? res.send("Already Exists") : res.json({ success: false });
        }
        try {
            const resp = await axios.get(`https://cdn.syndication.twimg.com/tweet-result?id=${idMatch[1]}&token=x`);
            
            // 🔥 هنا يتم تثبيت الثيم للتغريدة 🔥
            const newTweet = { 
                ...resp.data, 
                customSettings: { theme: theme || 'classic' }, 
                customDuration: null 
            };
            
            queue.push(newTweet);
            updateAdmin();
            saveDatabase();
            return res.send ? res.send("Added") : res.json({ success: true });
        } catch (e) { return res.status(500).json({ error: 'Error Fetching' }); }
    } else { return res.status(400).json({ error: 'Invalid URL' }); }
}

// تعديل تغريدة موجودة (لتغيير الثيم لاحقاً)
app.post('/api/edit_tweet', (req, res) => {
    const { index, theme } = req.body;
    if (queue[index]) {
        // إنشاء كائن الإعدادات إذا لم يكن موجوداً
        if (!queue[index].customSettings) queue[index].customSettings = {};
        
        // تحديث الثيم
        queue[index].customSettings.theme = theme;
        
        saveDatabase();
        // إذا كانت هي المعروضة حالياً، قم بتحديث الشاشة فوراً
        if (currentIndex === index) showTweet(index); else updateAdmin();
    }
    res.json({ success: true });
});

app.post('/api/add', async (req, res) => {
    let { url, theme } = req.body;
    if (url) await processAdd(url, theme, res); else res.status(400).json({ error: 'No URL' });
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

// Stream Deck & Debug
app.get('/trigger_add', (req, res) => res.send("Use Admin Page"));
app.get('/trigger_next', (req, res) => { if(queue.length){ showTweet((currentIndex+1)%queue.length); res.send("Next"); } else res.send("Empty"); });
app.get('/trigger_prev', (req, res) => { if(queue.length){ showTweet((currentIndex-1+queue.length)%queue.length); res.send("Prev"); } else res.send("Empty"); });
app.get('/trigger_auto', (req, res) => { autoState.active = !autoState.active; if(autoState.active) (currentIndex===-1?showTweet(0):showTweet(currentIndex)); else { clearTimeout(autoState.timer); updateAdmin(); } res.send(autoState.active?"Auto ON":"Auto OFF"); });
app.get('/hide', (req, res) => { io.emit('hide_tweet'); clearTimeout(autoState.timer); autoState.active = false; updateAdmin(); res.send('Hidden'); });
app.get('/debug-save', async (req, res) => { try { const r = await axios.get(API_URL); res.send(`Queue: ${r.data.queue.length}`); } catch(e){ res.send(e.message); } });

io.on('connection', (s) => updateAdmin());
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server Ready on ${PORT}`));