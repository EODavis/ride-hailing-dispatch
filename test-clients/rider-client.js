const WebSocket = require('ws');

const riderId = process.argv[2] || 'rider-1';
const lat = parseFloat(process.argv[3]) || 6.5244;
const lng = parseFloat(process.argv[4]) || 3.3792;

const ws = new WebSocket('ws://localhost:5002');

ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'register', riderId }));

    // Wait a moment for registration, then request a ride
    setTimeout(() => {
        console.log(`${riderId} requesting a ride at ${lat}, ${lng}`);
        ws.send(JSON.stringify({ type: 'request-ride', lat, lng }));
    }, 1000);
});

ws.on('message', (data) => {
    console.log(`${riderId} received:`, data.toString());  
})