const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const clipboardy = require('clipboardy'); // مكتبة قراءة المنسوخ

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// جعل مجلد public متاحاً للمتصفح
app.use(express.static('public'));

// رابط الزر في Stream Deck
app.get('/trigger', async (req, res) => {
    try {
        // قراءة الرابط من الحافظة
        const text = await clipboardy.read();
        
        // التأكد أنه رابط تغريدة
        const idMatch = text.match(/status\/(\d+)/);
        
        if (idMatch && idMatch[1]) {
            console.log(`✅ Tweet Detected: ${idMatch[1]}`);
            io.emit('show_tweet', { id: idMatch[1] }); // إرسال لـ OBS
            res.send(`Success: ${idMatch[1]}`);
        } else {
            console.log('❌ No tweet link found');
            res.send('Error: انسخ رابط تغريدة أولاً!');
        }
    } catch (error) {
        console.error(error);
        res.send('Server Error');
    }
});

// رابط إخفاء التغريدة
app.get('/hide', (req, res) => {
    io.emit('hide_tweet');
    res.send('Tweet Hidden');
});

server.listen(3000, () => {
    console.log('🚀 ZairuDuo System Ready!');
    console.log('OBS Link: http://localhost:3000/overlay.html');
    console.log('StreamDeck Link: http://localhost:3000/trigger');
});