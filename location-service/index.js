const express = require('express');
const { WebSocketServer } = require('ws');
const Redis = require ('ioredis');

const app = express();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Subscribe to a pattern covering every driver's notify channel
subscriber.psubscribe('driver-notify:*');

subscriber.on('pmessage', (pattern, channel, message) => {
  const driverId = channel.split(':')[1];
  const ws = connectedDrivers.get(driverId);

  if (ws && ws.readyState === ws.OPEN) {
    ws.send(message);
    console.log(`Pushed ride assignment to driver ${driverId}`);
  } else {
    console.log(`Driver ${driverId} not connected here — message dropped`);
  }
});

const server = app.listen(process.env.PORT || 5001, () => {
    console.log(`Location Service HTTP listening on ${process.env.PORT || 5001}`);
});

const wss = new WebSocketServer({ server });

// Tracks which WebSocket connection belongs to which driver, so we can clean up on disconnect
const connectedDrivers = new Map();

wss.on('connection', (ws) => {
    let driverId = null;

    ws.on('message', async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return ws.send(JSON.stringify({ error: 'Invalid JSON' })); 
        }

        if (msg.type === 'register') {
            driverId = msg.driverId;
            connectedDrivers.set(driverId, ws);
            await redis.hset(`driver:${driverId}`, 'status', 'available');
            console.log(`Driver ${driverId} connected`);
            return ws.send(JSON.stringify({ type: 'registered', driverId }));
        }

        if (msg.type === 'location' && driverId) {
            const { lat, lng } = msg;
            // GEOADD stores this driver's position in a geospatial sorted set
            await redis.geoadd('drivers:locations', lng, lat, driverId);
            return;
        }
    });

    ws.on('close', async () => {
        if (driverId) {
            connectedDrivers.delete(driverId);
            await redis.zrem('drivers:locations', driverId);
            await redis.del(`driver:${driverId}`);
            console.log(`Driver ${driverId} disconnected and removed`);
        }
    });
});

