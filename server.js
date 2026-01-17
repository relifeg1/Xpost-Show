const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const clipboardy = require('clipboardy'); // ملاحظة: النسخ لن يعمل في السيرفر السحابي
const axios = require('axios');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

const DB_FILE = 'database.json';
let queue = [];
let currentIndex = -1;

// حالة التشغيل التلقائي
let autoState = { active: false, timer: null };

// الإعدادات العامة
let globalSettings = { 
    showAvatar: true, showName: true, showMedia: true, 
    showStats: true, showDate: true, scale: 1.0,
    defaultDuration: 10
};

// تحميل البيانات (إن وجدت)
if (fs.existsSync(DB_FILE)) {
    try { queue = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { queue = []; }
}

function saveDatabase() {
    // محاولة الحفظ (في Render البيانات قد تمسح عند إعادة التشغيل وهذا طبيعي للخطة المجانية)
    try { fs.writeFileSync(DB_FILE, JSON.stringify(queue, null, 2)); } catch (e) { console.error("Save Error", e); }
}

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
        console.log(`⏱️ Auto Next in: ${duration/1000}s`);
        autoState.timer = setTimeout(() => {
            showTweet((currentIndex + 1) % queue.length);
        }, duration);
    }
}

// دالة المعالجة الموحدة للإضافة
async function processAdd(url, res) {
    const idMatch = url && url.match(/(?:twitter|x)\.com\/.*\/status\/(\d+)/);
    
    if (idMatch && idMatch[1]) {
        if (queue.find(t => t.id_str === idMatch[1])) {
            return res.send ? res.send("Already Exists") : res.json({ success: false, msg: 'موجودة مسبقاً' });
        }
        try {
            const resp = await axios.get(`https://cdn.syndication.twimg.com/tweet-result?id=${idMatch[1]}&token=x`);
            queue.push({ ...resp.data, customSettings: null, customDuration: null });
            saveDatabase();
            updateAdmin();
            return res.send ? res.send("Added") : res.json({ success: true });
        } catch (e) { 
            return res.send ? res.send("Error Fetching") : res.status(500).json({ error: 'فشل الجلب من المصدر' }); 
        }
    } else {
        return res.send ? res.send("Invalid Link") : res.status(400).json({ error: 'رابط غير صحيح' });
    }
}

// --- APIs ---

app.post('/api/add', async (req, res) => {
    // محاولة استخدام الرابط المرسل، وإذا لم يوجد نحاول القراءة من السيرفر (لن يعمل في السحاب)
    let url = req.body.url;
    if (!url) {
        try { url = await clipboardy.read(); } catch(e) { console.log("Clipboard not available on server"); }
    }
    await processAdd(url, res);
});

app.post('/api/control', (req, res) => {
    const { action, index } = req.body;
    if (queue.length === 0) return res.json({ success: false });

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

app.post('/api/edit_tweet', (req, res) => {
    const { index, customSettings, customDuration } = req.body;
    if (queue[index]) {
        queue[index].customSettings = customSettings;
        queue[index].customDuration = customDuration;
        saveDatabase();
        if (currentIndex === index) showTweet(index); else updateAdmin();
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
    if (action === 'move_up' && index > 0) {
        [queue[index], queue[index - 1]] = [queue[index - 1], queue[index]];
        if(currentIndex === index) currentIndex--; else if(currentIndex === index-1) currentIndex++;
    }
    if (action === 'move_down' && index < queue.length - 1) {
        [queue[index], queue[index + 1]] = [queue[index + 1], queue[index]];
        if(currentIndex === index) currentIndex++; else if(currentIndex === index+1) currentIndex--;
    }
    saveDatabase(); updateAdmin();
    if (action.includes('move') && currentIndex !== -1) showTweet(currentIndex);
    res.json({ success: true });
});

app.post('/api/settings', (req, res) => {
    globalSettings = { ...globalSettings, ...req.body };
    io.emit('state_update', { settings: globalSettings });
    if (currentIndex !== -1 && !queue[currentIndex].customSettings) showTweet(currentIndex);
    res.json({ success: true });
});


// 🔥 روابط Stream Deck 🔥

// 1. إضافة (لن تعمل في Render من الحافظة، يجب الإرسال من الأدمن)
app.get('/trigger_add', async (req, res) => {
    try {
        const url = await clipboardy.read(); // سيفشل في السحاب
        await processAdd(url, res);
    } catch (e) {
        res.send("Server cannot read clipboard (Use Admin Panel)");
    }
});

// 2. تلقائي
app.get('/trigger_auto', (req, res) => {
    if (queue.length === 0) return res.send("Empty");
    autoState.active = !autoState.active;
    if (autoState.active) {
        if (currentIndex === -1) showTweet(0); else showTweet(currentIndex);
    } else {
        clearTimeout(autoState.timer); updateAdmin();
    }
    res.send(autoState.active ? "Auto ON" : "Auto OFF");
});

// 3. التالي
app.get('/trigger_next', (req, res) => {
    if (queue.length === 0) return res.send("Empty");
    showTweet((currentIndex + 1) % queue.length);
    res.send("Next");
});

// 4. السابق
app.get('/trigger_prev', (req, res) => {
    if (queue.length === 0) return res.send("Empty");
    showTweet((currentIndex - 1 + queue.length) % queue.length);
    res.send("Prev");
});

// 5. إخفاء
app.get('/hide', (req, res) => { 
    io.emit('hide_tweet'); clearTimeout(autoState.timer); autoState.active = false; updateAdmin(); res.send('Hidden'); 
});

io.on('connection', (s) => updateAdmin());

// 🛑 التعديل المهم لـ Render 🛑
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});