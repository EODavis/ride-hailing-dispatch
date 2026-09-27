const WebSocket = require('ws');

const driverId = process.argv[2] || 'driver-1';
const startLat = parseFloat(process.argv[3]) || 6.5244; // Lagos, as a default
const startLng = parseFloat(process.argv[4]) || 3.3792;

const ws = new WebSocket('ws://localhost:5001');

ws.on('open', () =>{
    ws.send(JSON.stringify({ type: 'register', driverId }));

    // Stimulate sending a location update every 3 seconds
    setInterval(() => {
        const jitteredLat = startLat + (Math.random() - 0.5) * 0.01;
        const jitteredLng = startLng + (Math.random() - 0.5) * 0.01;
        ws.send(JSON.stringify({ type: 'location', lat: jitteredLat, lng: jitteredLng }));
        console.log(`${driverId} sent location: ${jitteredLat.toFixed(4)}, ${jitteredLng.toFixed(4)}`);
    }, 3000);
});

ws.on('message', (data) => {
    console.log(`${driverId} received:`, data.toString());
});

ws.on('close', () => console.log(`${driverId} disconnected`));

