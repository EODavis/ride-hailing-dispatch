const express = require('express');
const { WebSocketServer } = require('ws');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');

const app = express();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const claimDriverScript = fs.readFileSync(path.join(__dirname, 'lua/claimDriver.lua'), 'utf8');

const server = app.listen(process.env.PORT || 5002, () => {
  console.log(`Dispatch Service listening on ${process.env.PORT || 5002}`);
});

const wss = new WebSocketServer({ server });
const connectedRiders = new Map();

wss.on('connection', (ws) => {
  let riderId = null;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return ws.send(JSON.stringify({ error: 'Invalid JSON' }));
    }

    if (msg.type === 'register') {
      riderId = msg.riderId;
      connectedRiders.set(riderId, ws);
      return ws.send(JSON.stringify({ type: 'registered', riderId }));
    }

    if (msg.type === 'request-ride' && riderId) {
      await handleRideRequest(riderId, msg.lat, msg.lng, ws);
    }
  });

  ws.on('close', () => {
    if (riderId) connectedRiders.delete(riderId);
  });
});

async function handleRideRequest(riderId, lat, lng, riderWs) {
  // GEOSEARCH: find drivers within 5km, sorted nearest-first
  const candidates = await redis.geosearch(
    'drivers:locations',
    'FROMLONLAT', lng, lat,
    'BYRADIUS', 5, 'km',
    'ASC'
  );

  if (candidates.length === 0) {
    return riderWs.send(JSON.stringify({ type: 'no-drivers-available' }));
  }

  // Try to claim drivers nearest-first, until one succeeds
  for (const driverId of candidates) {
    const claimed = await redis.eval(claimDriverScript, 1, `driver:${driverId}`);

    if (claimed === 1) {
      const rideId = `${riderId}-${Date.now()}`;

      // Tell Location Service (via pub/sub) to push this to the driver's actual socket
      await publisher.publish(
        `driver-notify:${driverId}`,
        JSON.stringify({ type: 'ride-assigned', rideId, riderId, pickupLat: lat, pickupLng: lng })
      );

      riderWs.send(JSON.stringify({ type: 'matched', rideId, driverId }));
      console.log(`Matched rider ${riderId} with driver ${driverId} (ride ${rideId})`);
      return;
    }
    // If claim failed (someone else grabbed this driver microseconds earlier), try the next candidate
  }

  riderWs.send(JSON.stringify({ type: 'no-drivers-available', reason: 'all nearby drivers were just claimed' }));
}
