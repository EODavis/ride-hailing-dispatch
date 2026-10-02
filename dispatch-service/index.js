const express = require('express');
const { WebSocketServer } = require('ws');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');
const { chargeRiderWithRetries } = require('./payment');

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

const RIDE_FARE = 15.0; 

async function handleRideRequest(riderId, lat, lng, riderWs) {
  const candidates = await redis.geosearch(
    'drivers:locations',
    'FROMLONLAT', lng, lat,
    'BYRADIUS', 5, 'km',
    'ASC'
  );

  if (candidates.length === 0) {
    return riderWs.send(JSON.stringify({ type: 'no-drivers-available' }));
  }

  for (const driverId of candidates) {
    const claimed = await redis.eval(claimDriverScript, 1, `driver:${driverId}`);

    if (claimed === 1) {
      const rideId = `${riderId}-${Date.now()}`;
      console.log(`Driver ${driverId} claimed for ride ${rideId} — attempting payment`);

      try {
        const paymentResult = await chargeRiderWithRetries(rideId, riderId, RIDE_FARE);

        // Payment succeeded — proceed exactly as in Project 15
        await publisher.publish(
          `driver-notify:${driverId}`,
          JSON.stringify({ type: 'ride-assigned', rideId, riderId, pickupLat: lat, pickupLng: lng })
        );

        riderWs.send(JSON.stringify({
          type: 'matched',
          rideId,
          driverId,
          payment: paymentResult.data,
        }));

        console.log(`Ride ${rideId} fully confirmed — driver ${driverId}, payment ${paymentResult.data.transactionId}`);
        return;

      } catch (err) {
        // Payment failed after retries and/or the breaker is open — this is the saga's compensating step
        console.log(`Payment failed for ride ${rideId} after retries — compensating: releasing driver ${driverId}`);

        await redis.hset(`driver:${driverId}`, 'status', 'available');

        await publisher.publish(
          `driver-notify:${driverId}`,
          JSON.stringify({ type: 'ride-cancelled', reason: 'payment failed' })
        );

        riderWs.send(JSON.stringify({
          type: 'payment-failed',
          message: 'We could not process payment for this ride. Please try again.',
        }));

        return; // Don't try the next candidate driver — the rider's payment issue won't fix itself by finding a different driver
      }
    }
  }

  riderWs.send(JSON.stringify({ type: 'no-drivers-available', reason: 'all nearby drivers were just claimed' }));
}
